import { randomUUID } from "node:crypto";
import { jsonValue } from "./database.mjs";
import { isQuietTime, nextQuietEnd } from "./time.mjs";
import { renderMessageTemplate } from "./messaging-templates.mjs";
import { renderBrandedEmail } from "./email-render.mjs";

// Deliberately conservative: one @, a dot in the domain, no spaces. Anything
// that fails this is treated as "no eligible recipient" and never sent.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

const quietHoursFallback = { start: "21:00", end: "08:00" };

function positiveInteger(value, fallback, { min = 1, max = 10_000 } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function log(logger, level, event, details = {}) {
  const sink = logger?.[level] ?? logger?.log;
  if (!sink) return;
  sink.call(logger, JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details
  }));
}

function asTenant(row) {
  return {
    ...row,
    quiet_hours: jsonValue(row.quiet_hours, quietHoursFallback),
    review_config: jsonValue(row.review_config, {}),
    messaging_config: jsonValue(row.messaging_config, {}),
    contact_config: jsonValue(row.contact_config, {}),
    links: jsonValue(row.links, {}),
    branding: jsonValue(row.branding, {})
  };
}

function recipientFor(message) {
  if (message.template_id === "complaint_owner_alert") {
    return message.owner_alert_email || null;
  }
  if (message.channel === "email") return message.email || null;
  if (message.channel === "whatsapp" || message.channel === "sms") return message.phone_e164 || null;
  if (message.channel === "instagram") return message.manychat_subscriber_id || null;
  return null;
}

function hasConsent(message) {
  if (message.template_id === "complaint_owner_alert") return Boolean(message.owner_alert_email);
  if (message.channel === "email") return message.email_consent === true;
  if (message.channel === "whatsapp") return message.whatsapp_consent === true;
  if (message.channel === "sms") return message.sms_consent === true;
  // Instagram DMs go through ManyChat; a subscriber id only exists because the person messaged the page.
  if (message.channel === "instagram") return Boolean(message.manychat_subscriber_id);
  return false;
}

function isTwoHourReminder(message) {
  return message.template_id === "appointment_t_2h";
}

function retryDelayMs(attemptCount, baseRetryMs, maxRetryMs) {
  return Math.min(maxRetryMs, baseRetryMs * (2 ** Math.max(0, attemptCount - 1)));
}

async function createStateSchema(db) {
  await db.exec(`
    create table if not exists message_dispatch_state (
      message_id uuid primary key references messages(id) on delete cascade,
      tenant_id uuid not null references tenants(id) on delete cascade,
      attempt_count integer not null default 0 check (attempt_count >= 0),
      next_attempt_at timestamptz,
      lock_token uuid,
      locked_at timestamptz,
      terminal_at timestamptz,
      terminal_status text,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await db.exec("create index if not exists message_dispatch_state_claim_idx on message_dispatch_state (tenant_id, next_attempt_at) where terminal_at is null");
  await db.exec("alter table message_dispatch_state enable row level security");
  await db.exec(`
    do $$
    begin
      if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'message_dispatch_state'
          and policyname = 'tenant_isolation'
      ) then
        create policy tenant_isolation on message_dispatch_state
          using (tenant_id = app_current_tenant_id())
          with check (tenant_id = app_current_tenant_id());
      end if;
    end;
    $$;
  `);
}

export class MessageDispatcher {
  constructor({
    db,
    transport,
    logger = console,
    maxAttempts = 3,
    batchSize = 25,
    baseRetryMs = 60_000,
    maxRetryMs = 3_600_000,
    claimLeaseMs = 15 * 60_000,
    env = process.env
  }) {
    if (!db) throw new Error("MessageDispatcher requires a database.");
    if (!transport) throw new Error("MessageDispatcher requires a transport.");
    this.db = db;
    this.transport = transport;
    this.logger = logger;
    this.maxAttempts = positiveInteger(env.MESSAGE_MAX_ATTEMPTS ?? maxAttempts, 3, { max: 20 });
    this.batchSize = positiveInteger(env.MESSAGE_DISPATCH_BATCH_SIZE ?? batchSize, 25, { max: 500 });
    this.baseRetryMs = positiveInteger(env.MESSAGE_RETRY_BASE_MS ?? baseRetryMs, 60_000, { max: 86_400_000 });
    this.maxRetryMs = positiveInteger(env.MESSAGE_RETRY_MAX_MS ?? maxRetryMs, 3_600_000, { max: 7 * 86_400_000 });
    this.claimLeaseMs = positiveInteger(env.MESSAGE_CLAIM_LEASE_MS ?? claimLeaseMs, 15 * 60_000, { max: 24 * 60 * 60_000 });
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await createStateSchema(this.db);
    this.initialized = true;
  }

  async expireAbandonedClaims(now) {
    const expiredBefore = new Date(now.getTime() - this.claimLeaseMs).toISOString();
    const result = await this.db.transaction(async (tx) => {
      const failed = await tx.query(`
        update messages m
        set delivery_status = 'failed'
        from message_dispatch_state s
        where s.message_id = m.id
          and m.delivery_status = 'queued'
          and s.lock_token is not null
          and s.locked_at < $1::timestamptz
        returning m.id::text
      `, [expiredBefore]);
      if (failed.rows.length) {
        await tx.query(`
          update message_dispatch_state
          set lock_token = null,
              terminal_at = $2::timestamptz,
              terminal_status = 'failed_claim_expired',
              last_error = 'Delivery claim expired before an outcome was recorded. Marked failed to avoid a duplicate external send.',
              updated_at = $2::timestamptz
          where message_id = any($1::uuid[])
        `, [failed.rows.map((row) => row.id), now.toISOString()]);
      }
      return failed.rows.map((row) => row.id);
    });
    for (const messageId of result) {
      log(this.logger, "error", "message_claim_expired", { messageId });
    }
    return result;
  }

  async claimDue(now) {
    return this.db.transaction(async (tx) => {
      await tx.query(`
        insert into message_dispatch_state (message_id, tenant_id, next_attempt_at)
        select m.id, m.tenant_id, m.scheduled_for
        from messages m
        where m.direction = 'outbound'
          and m.delivery_status = 'queued'
        on conflict (message_id) do nothing
      `);

      const lockClause = tx.driver === "postgres" ? "for update of m, s skip locked" : "";
      const due = await tx.query(`
        select
          m.id::text, m.tenant_id::text, m.contact_id::text, m.appointment_id::text,
          m.channel, m.direction, m.body, m.template_id, m.delivery_status, m.scheduled_for,
          s.attempt_count,
          c.first_name, c.email, c.phone_e164, c.email_consent, c.manychat_subscriber_id, c.whatsapp_consent, c.sms_consent,
          a.starts_at, a.ends_at, a.service, a.staff,
          t.name as tenant_name, t.locale, t.fallback_locale, t.timezone,
          t.quiet_hours, t.review_config, t.messaging_config, t.contact_config, t.links, t.branding,
          t.review_config->>'ownerAlertEmail' as owner_alert_email
        from messages m
        join message_dispatch_state s on s.message_id = m.id
        join tenants t on t.id = m.tenant_id
        left join contacts c on c.id = m.contact_id
        left join appointments a on a.id = m.appointment_id
        where m.direction = 'outbound'
          and m.delivery_status = 'queued'
          and coalesce(m.scheduled_for, $1::timestamptz) <= $1::timestamptz
          and coalesce(s.next_attempt_at, m.scheduled_for, $1::timestamptz) <= $1::timestamptz
          and s.lock_token is null
          and s.terminal_at is null
        order by m.scheduled_for nulls first, m.created_at
        limit $2
        ${lockClause}
      `, [now.toISOString(), this.batchSize]);

      const claimed = [];
      for (const row of due.rows) {
        const claimToken = randomUUID();
        const update = await tx.query(`
          update message_dispatch_state
          set lock_token = $2::uuid,
              locked_at = $3::timestamptz,
              attempt_count = attempt_count + 1,
              updated_at = $3::timestamptz
          where message_id = $1::uuid and lock_token is null and terminal_at is null
          returning attempt_count
        `, [row.id, claimToken, now.toISOString()]);
        if (update.rows.length) {
          claimed.push({
            ...row,
            attempt_count: update.rows[0].attempt_count,
            claimToken,
            tenant: asTenant({
              id: row.tenant_id,
              name: row.tenant_name,
              locale: row.locale,
              fallback_locale: row.fallback_locale,
              timezone: row.timezone,
              quiet_hours: row.quiet_hours,
              review_config: row.review_config,
              messaging_config: row.messaging_config,
              contact_config: row.contact_config,
              links: row.links,
              branding: row.branding
            })
          });
        }
      }
      return claimed;
    });
  }

  async finish(message, status, now, { error = null, retryAt = null, recipient = null, subject = null, providerMessageId = null } = {}) {
    const terminal = ["sent", "stubbed", "failed", "dropped_quiet_hours"].includes(status);
    const result = await this.db.transaction(async (tx) => {
      const updateMessage = await tx.query(`
        update messages
        set delivery_status = $3,
            scheduled_for = coalesce($4::timestamptz, scheduled_for),
            sent_at = case when $3 = 'sent' then $5::timestamptz else sent_at end,
            recipient = coalesce($7, recipient),
            subject = coalesce($8, subject),
            provider_message_id = coalesce($9, provider_message_id),
            last_error = case when $3 = 'sent' then null else coalesce($6, last_error) end
        where id = $1::uuid
          and delivery_status = 'queued'
          and exists (
            select 1 from message_dispatch_state
            where message_id = $1::uuid and lock_token = $2::uuid
          )
        returning id::text
      `, [message.id, message.claimToken, status, retryAt, now.toISOString(), error, recipient, subject, providerMessageId]);
      if (!updateMessage.rows.length) return false;
      await tx.query(`
        update message_dispatch_state
        set lock_token = null,
            locked_at = null,
            next_attempt_at = $4::timestamptz,
            terminal_at = case when $3::boolean then $5::timestamptz else null end,
            terminal_status = case when $3::boolean then $6 else null end,
            last_error = $7,
            updated_at = $5::timestamptz
        where message_id = $1::uuid and lock_token = $2::uuid
      `, [
        message.id,
        message.claimToken,
        terminal,
        retryAt,
        now.toISOString(),
        terminal ? status : null,
        error
      ]);
      return true;
    });
    return result;
  }

  async deferForQuietHours(message, now) {
    if (!isQuietTime(now, message.tenant.timezone, message.tenant.quiet_hours ?? quietHoursFallback)) return false;
    if (isTwoHourReminder(message)) {
      await this.finish(message, "dropped_quiet_hours", now, {
        error: "T-2h reminder was due during quiet hours and was intentionally dropped."
      });
      log(this.logger, "info", "message_dropped_quiet_hours", { messageId: message.id, templateId: message.template_id });
      return true;
    }
    const retryAt = nextQuietEnd(now, message.tenant.timezone, message.tenant.quiet_hours ?? quietHoursFallback);
    await this.finish(message, "queued", now, {
      error: "Deferred until quiet hours end.",
      retryAt: retryAt.toISOString()
    });
    log(this.logger, "info", "message_deferred_quiet_hours", {
      messageId: message.id,
      templateId: message.template_id,
      scheduledFor: retryAt.toISOString()
    });
    return true;
  }

  async rejectWithoutConsent(message, now) {
    const recipient = recipientFor(message);
    const badEmail = message.channel === "email" && recipient && !isValidEmail(recipient);
    if (hasConsent(message) && recipient && !badEmail) return false;
    const reason = badEmail
      ? `Invalid email address: ${recipient}`
      : recipient ? `Missing ${message.channel} consent.` : `No eligible ${message.channel} recipient.`;
    await this.finish(message, "failed", now, { error: reason, recipient: recipient || null });
    log(this.logger, "warn", "message_not_sent_ineligible", {
      messageId: message.id,
      channel: message.channel,
      templateId: message.template_id,
      reason
    });
    return true;
  }

  async dispatchClaimed(message, now) {
    if (await this.rejectWithoutConsent(message, now)) return "failed";
    if (await this.deferForQuietHours(message, now)) return isTwoHourReminder(message) ? "dropped_quiet_hours" : "deferred";

    const appointmentContext = {
      starts_at: message.starts_at, ends_at: message.ends_at, service: message.service, staff: message.staff
    };
    const rendered = renderMessageTemplate({
      tenant: message.tenant,
      templateId: message.template_id,
      contact: { first_name: message.first_name },
      appointment: appointmentContext,
      complaint: { body: message.body }
    });
    // The rendered copy was persisted when the sequence was created. Preserve
    // that immutable queued body so delayed delivery does not change customer
    // wording if the tenant later edits a template.
    rendered.body = message.body || rendered.body;
    // Branded HTML for email; plain-text stays the source copy above.
    if (message.channel === "email") {
      const branded = renderBrandedEmail({
        tenant: message.tenant,
        templateId: message.template_id,
        rendered,
        appointment: appointmentContext
      });
      rendered.html = branded.html;
      rendered.subject = branded.subject;
    }
    const recipient = recipientFor(message);
    try {
      const outcome = await this.transport.send({ message, tenant: message.tenant, recipient, rendered });
      const status = outcome?.status === "stubbed" ? "stubbed" : "sent";
      await this.finish(message, status, now, {
        recipient: outcome?.recipient ?? recipient ?? null,
        subject: outcome?.subject ?? rendered.subject ?? null,
        providerMessageId: outcome?.providerMessageId ?? null
      });
      log(this.logger, "info", "message_dispatched", {
        messageId: message.id,
        channel: message.channel,
        templateId: message.template_id,
        status,
        provider: outcome?.provider ?? null,
        providerMessageId: outcome?.providerMessageId ?? null
      });
      return status;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (message.attempt_count >= this.maxAttempts) {
        await this.finish(message, "failed", now, { error: detail, recipient: recipient || null, subject: rendered.subject ?? null });
        log(this.logger, "error", "message_failed_terminal", {
          messageId: message.id,
          attempts: message.attempt_count,
          message: detail
        });
        return "failed";
      }
      const retryAt = new Date(now.getTime() + retryDelayMs(message.attempt_count, this.baseRetryMs, this.maxRetryMs));
      await this.finish(message, "queued", now, { error: detail, retryAt: retryAt.toISOString(), recipient: recipient || null, subject: rendered.subject ?? null });
      log(this.logger, "warn", "message_retry_scheduled", {
        messageId: message.id,
        attempts: message.attempt_count,
        retryAt: retryAt.toISOString(),
        message: detail
      });
      return "retried";
    }
  }

  async runOnce({ now = new Date() } = {}) {
    await this.initialize();
    const currentTime = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(currentTime.getTime())) throw new Error("MessageDispatcher.runOnce requires a valid time.");
    const expired = await this.expireAbandonedClaims(currentTime);
    const claimed = await this.claimDue(currentTime);
    const counts = { claimed: claimed.length, sent: 0, stubbed: 0, retried: 0, failed: expired.length, deferred: 0, dropped_quiet_hours: 0 };
    for (const message of claimed) {
      log(this.logger, "info", "message_claimed", {
        messageId: message.id,
        attempt: message.attempt_count,
        channel: message.channel,
        templateId: message.template_id
      });
      const status = await this.dispatchClaimed(message, currentTime);
      if (Object.hasOwn(counts, status)) counts[status] += 1;
    }
    log(this.logger, "info", "message_dispatch_cycle_complete", counts);
    return counts;
  }
}
