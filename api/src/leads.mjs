// Service 4.1 — Lead Follow-Up. Every inquiry from any channel becomes a lead, gets a personalised
// follow-up within minutes if no booking happened, and a ladder afterwards. Exits the moment the
// contact books. Sources: website form, ManyChat (Instagram / WhatsApp DM), the receptionist, manual.
import { isQuietTime, nextQuietEnd } from "./time.mjs";
import { renderMessageTemplate, emailTypeEnabled } from "./messaging-templates.mjs";

export const LEAD_SOURCES = ["website", "instagram", "whatsapp", "call", "google", "manual"];
export const LEAD_STATUSES = ["new", "contacted", "qualified", "booked", "lost"];

// Follow-up ladder — the exact cadence from the brief:
//   immediate → 10 minutes → 2 hours → next day → 3 days.
// Every step exits the moment the contact replies or books.
export const LEAD_LADDER = [
  { templateId: "lead_followup_instant", sequenceType: "lead_follow_up", offsetMs: 0 },
  { templateId: "lead_followup_10min", sequenceType: "lead_follow_up", offsetMs: 10 * 60_000 },
  { templateId: "lead_followup_2h", sequenceType: "lead_follow_up", offsetMs: 2 * 3_600_000 },
  { templateId: "lead_followup_day_1", sequenceType: "lead_follow_up", offsetMs: 24 * 3_600_000 },
  { templateId: "lead_followup_day_3", sequenceType: "lead_follow_up", offsetMs: 72 * 3_600_000 }
];
export const LEAD_TEMPLATE_IDS = [
  ...new Set([
    ...LEAD_LADDER.map((step) => step.templateId),
    // single operational email variant (used when the lead is reachable by email)
    "lead_followup",
    // legacy ladder ids that may still be queued from before the cadence change
    "lead_followup_day_3", "lead_reengage_day_7", "lead_reengage_day_14"
  ])
];

const DEFAULT_LEAD_FOLLOWUP_DELAY_MIN = 30;

const clientError = (message) => Object.assign(new Error(message), { statusCode: 400 });

export function normalisePhone(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  // Retell web/test calls and blocked caller-id arrive as these — not real numbers.
  if (!raw || ["web", "web_call", "webcall", "anonymous", "unknown", "restricted", "private", "+0", "0"].includes(raw)) {
    return null;
  }
  const digits = raw.replace(/[^\d+]/g, "");
  const bare = digits.replace(/\D/g, "");
  if (!bare || /^0+$/.test(bare) || bare.length < 7) return null; // too short / all zeros
  if (digits.startsWith("+")) return `+${bare}`;
  if (bare.startsWith("00")) return `+${bare.slice(2)}`;
  if (bare.startsWith("0") && bare.length === 10) return `+41${bare.slice(1)}`; // Swiss national format
  return `+${bare}`;
}

export function firstNameOf(name) {
  return String(name ?? "").trim().split(/\s+/)[0] || "Gast";
}

/** Pick the channel we can actually reach this lead on, preferring where they came from. */
export function channelForLead({ source, phone, email, manychatSubscriberId }) {
  if (source === "instagram" && manychatSubscriberId) return "instagram";
  if (source === "whatsapp" && (manychatSubscriberId || phone)) return "whatsapp";
  if (email) return "email";
  if (phone) return "whatsapp";
  if (manychatSubscriberId) return "instagram";
  return null;
}

export function normaliseLeadInput(body = {}) {
  const source = String(body.source ?? "website").toLowerCase();
  if (!LEAD_SOURCES.includes(source)) throw clientError(`source must be one of ${LEAD_SOURCES.join(", ")}.`);
  const phone = normalisePhone(body.phone ?? body.customerPhone);
  const email = String(body.email ?? body.customerEmail ?? "").trim().toLowerCase() || null;
  const manychatSubscriberId = body.manychatSubscriberId ? String(body.manychatSubscriberId) : null;
  if (!phone && !email && !manychatSubscriberId) {
    throw clientError("A lead needs at least a phone, an email, or a ManyChat subscriber id.");
  }
  const urgency = String(body.urgency ?? "flexible").toLowerCase();
  return {
    source,
    name: String(body.name ?? body.customerName ?? "").trim(),
    phone,
    email,
    manychatSubscriberId,
    serviceInterest: String(body.serviceInterest ?? body.service ?? "").trim() || null,
    urgency: ["now", "this_week", "flexible"].includes(urgency) ? urgency : "flexible",
    preferredTime: String(body.preferredTime ?? "").trim() || null,
    notes: String(body.notes ?? "").trim() || null,
    whatsappConsent: Boolean(body.whatsappConsent ?? (source === "whatsapp")),
    emailConsent: Boolean(body.emailConsent ?? Boolean(email))
  };
}

/** Normalise a ManyChat "External Request" payload into our lead shape. */
export function leadFromManyChat(body = {}) {
  const custom = body.custom_fields ?? body.customFields ?? {};
  const channel = String(body.channel ?? "instagram").toLowerCase();
  return normaliseLeadInput({
    source: channel === "whatsapp" ? "whatsapp" : "instagram",
    name: [body.first_name ?? body.firstName, body.last_name ?? body.lastName].filter(Boolean).join(" ") || body.name || body.ig_username || "",
    phone: body.phone ?? body.whatsapp_phone ?? custom.phone,
    email: body.email ?? custom.email,
    manychatSubscriberId: body.subscriber_id ?? body.subscriberId ?? body.id,
    serviceInterest: custom.service ?? custom.service_interest ?? body.service,
    urgency: custom.urgency ?? body.urgency,
    preferredTime: custom.preferred_time ?? custom.preferredTime ?? body.preferred_time,
    notes: custom.notes ?? body.last_input_text ?? body.notes,
    whatsappConsent: channel === "whatsapp",
    emailConsent: Boolean(body.email ?? custom.email)
  });
}

async function upsertContact(client, tenantId, lead) {
  const contactSource = lead.source === "manual" ? "call" : lead.source;
  if (lead.phone) {
    const r = await client.query(`
      insert into contacts (tenant_id, first_name, last_name, phone_e164, email, source, whatsapp_consent, email_consent, manychat_subscriber_id)
      values ($1::uuid, $2, nullif($3, ''), $4, $5, $6, $7, $8, $9)
      on conflict (tenant_id, phone_e164) do update set
        first_name = coalesce(nullif(excluded.first_name, 'Gast'), contacts.first_name),
        last_name = coalesce(excluded.last_name, contacts.last_name),
        email = coalesce(excluded.email, contacts.email),
        whatsapp_consent = contacts.whatsapp_consent or excluded.whatsapp_consent,
        email_consent = contacts.email_consent or excluded.email_consent,
        manychat_subscriber_id = coalesce(excluded.manychat_subscriber_id, contacts.manychat_subscriber_id),
        updated_at = now()
      returning id::text
    `, [tenantId, firstNameOf(lead.name), lead.name.split(/\s+/).slice(1).join(" "), lead.phone, lead.email, contactSource, lead.whatsappConsent, lead.emailConsent, lead.manychatSubscriberId]);
    return r.rows[0].id;
  }
  if (lead.manychatSubscriberId) {
    const existing = await client.query(
      `select id::text from contacts where tenant_id = $1::uuid and manychat_subscriber_id = $2 limit 1`,
      [tenantId, lead.manychatSubscriberId]
    );
    if (existing.rows.length) {
      await client.query(`update contacts set email = coalesce($3, email), email_consent = email_consent or $4, updated_at = now() where id = $1::uuid and tenant_id = $2::uuid`,
        [existing.rows[0].id, tenantId, lead.email, lead.emailConsent]);
      return existing.rows[0].id;
    }
  }
  if (lead.email) {
    const existing = await client.query(
      `select id::text from contacts where tenant_id = $1::uuid and lower(email) = $2 limit 1`, [tenantId, lead.email]
    );
    if (existing.rows.length) return existing.rows[0].id;
  }
  const r = await client.query(`
    insert into contacts (tenant_id, first_name, last_name, email, source, whatsapp_consent, email_consent, manychat_subscriber_id)
    values ($1::uuid, $2, nullif($3, ''), $4, $5, $6, $7, $8) returning id::text
  `, [tenantId, firstNameOf(lead.name), lead.name.split(/\s+/).slice(1).join(" "), lead.email, contactSource, lead.whatsappConsent, lead.emailConsent, lead.manychatSubscriberId]);
  return r.rows[0].id;
}

async function hasUpcomingBooking(client, tenantId, contactId) {
  const r = await client.query(`
    select 1 from appointments
    where tenant_id = $1::uuid and contact_id = $2::uuid and status = 'booked' and starts_at > now() limit 1
  `, [tenantId, contactId]);
  return r.rows.length > 0;
}

export async function exitLeadSequences(client, tenantId, contactId, reason) {
  const messages = await client.query(`
    update messages set delivery_status = 'failed'
    where tenant_id = $1::uuid and contact_id = $2::uuid and delivery_status = 'queued'
      and (template_id = any($3::text[]) or template_id like 'reactivation_%')
    returning id
  `, [tenantId, contactId, LEAD_TEMPLATE_IDS]);
  await client.query(`
    update sequence_runs set status = 'exited', exit_reason = $3, next_fire_at = null, updated_at = now()
    where tenant_id = $1::uuid and contact_id = $2::uuid and status = 'active'
      and sequence_type in ('lead_follow_up', 're_engagement', 'reactivation')
  `, [tenantId, contactId, reason]);
  return messages.rows.length;
}

export async function markLeadBooked(client, tenantId, contactId, appointmentId) {
  const cancelled = await exitLeadSequences(client, tenantId, contactId, "booked");
  const r = await client.query(`
    update leads set status = 'booked', booked_appointment_id = $3::uuid, updated_at = now()
    where tenant_id = $1::uuid and contact_id = $2::uuid and status in ('new', 'contacted', 'qualified')
    returning id
  `, [tenantId, contactId, appointmentId]);
  const reactivated = await client.query(`
    update reactivation_targets set status = 'booked', booked_appointment_id = $3::uuid, updated_at = now()
    where tenant_id = $1::uuid and contact_id = $2::uuid and status in ('queued', 'sent', 'responded')
    returning campaign_id::text
  `, [tenantId, contactId, appointmentId]);
  if (reactivated.rows.length) {
    await client.query(`
      update reactivation_campaigns set bookings = bookings + 1, updated_at = now()
      where id = any($1::uuid[])
    `, [reactivated.rows.map((row) => row.campaign_id)]);
  }
  return { leadsMarked: r.rows.length, messagesCancelled: cancelled, reactivationBookings: reactivated.rows.length };
}

export class LeadService {
  constructor({ db, tenantLoader, logger = console, now = () => new Date() }) {
    this.db = db;
    this.tenantLoader = tenantLoader;
    this.logger = logger;
    this.now = now;
  }

  async createLead(tenantId, body) {
    const lead = normaliseLeadInput(body);
    const tenant = await this.tenantLoader(tenantId);
    return this.db.transaction(async (client) => {
      const contactId = await upsertContact(client, tenant.id, lead);
      const alreadyBooked = await hasUpcomingBooking(client, tenant.id, contactId);
      const channel = channelForLead(lead);
      const inserted = await client.query(`
        insert into leads (tenant_id, contact_id, source, service_interest, urgency, preferred_time, notes, status, channel)
        values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
        returning id::text, created_at
      `, [tenant.id, contactId, lead.source, lead.serviceInterest, lead.urgency, lead.preferredTime, lead.notes, alreadyBooked ? "booked" : "new", channel]);
      const leadId = inserted.rows[0].id;

      let scheduled = 0;
      if (!alreadyBooked && channel) {
        await exitLeadSequences(client, tenant.id, contactId, "superseded"); // one active ladder per contact
        const startedAt = this.now();
        // Email leads get ONE operational follow-up, not the multi-step ladder.
        // Other channels (WhatsApp / Instagram DM) keep the existing ladder.
        let steps = LEAD_LADDER;
        if (channel === "email") {
          if (emailTypeEnabled(tenant, "leadFollowup")) {
            const delayMin = Number(tenant.messaging_config?.email?.leadFollowupDelayMinutes) || DEFAULT_LEAD_FOLLOWUP_DELAY_MIN;
            steps = [{ templateId: "lead_followup", sequenceType: "lead_follow_up", offsetMs: delayMin * 60_000 }];
          } else {
            steps = [];
          }
        }
        for (const step of steps) {
          const dueAt = new Date(startedAt.getTime() + step.offsetMs);
          const fireAt = isQuietTime(dueAt, tenant.timezone, tenant.quiet_hours)
            ? nextQuietEnd(dueAt, tenant.timezone, tenant.quiet_hours)
            : dueAt;
          const rendered = renderMessageTemplate({
            tenant, templateId: step.templateId,
            contact: { first_name: firstNameOf(lead.name) },
            appointment: { service: lead.serviceInterest || "" },
            lead
          });
          const insertedMessage = await client.query(`
            insert into messages (tenant_id, contact_id, lead_id, channel, direction, body, subject, template_id, delivery_status, scheduled_for)
            values ($1::uuid, $2::uuid, $3::uuid, $4, 'outbound', $5, $6, $7, 'queued', $8::timestamptz)
            on conflict do nothing
            returning id
          `, [tenant.id, contactId, leadId, channel, rendered.body, rendered.subject || null, step.templateId, fireAt.toISOString()]);
          if (!insertedMessage.rows.length) continue;
          await client.query(`
            insert into sequence_runs (tenant_id, contact_id, sequence_type, status, current_step, next_fire_at, metadata)
            values ($1::uuid, $2::uuid, $3, 'active', $4, $5::timestamptz, $6::jsonb)
          `, [tenant.id, contactId, step.sequenceType, step.templateId, fireAt.toISOString(),
              JSON.stringify({ channel, leadId, originalDueAt: dueAt.toISOString(), quietHoursDeferred: fireAt.getTime() !== dueAt.getTime() })]);
          scheduled += 1;
        }
        if (scheduled) await client.query(`update leads set status = 'contacted', updated_at = now() where id = $1::uuid`, [leadId]);
      }
      await client.query(`
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload, occurred_at)
        values ($1::uuid, 'lead', $2::uuid, 'lead.created', $3, $4::jsonb, now())
      `, [tenant.id, leadId, lead.source, JSON.stringify({ channel, alreadyBooked, serviceInterest: lead.serviceInterest, urgency: lead.urgency })]);

      return {
        logged: true,
        leadId,
        contactId,
        status: alreadyBooked ? "booked" : scheduled ? "contacted" : "new",
        channel,
        followUpsScheduled: scheduled,
        message: alreadyBooked
          ? "This contact already has an upcoming appointment, so no follow-up sequence was started."
          : channel
            ? `Lead recorded. ${scheduled} follow-ups scheduled by ${channel}, the first within minutes.`
            : "Lead recorded, but there is no channel we can reach them on. The salon team should follow up manually."
      };
    });
  }

  async manychatLead(tenantId, body) {
    return this.createLead(tenantId, leadFromManyChat(body));
  }

  async updateLeadStatus(tenantId, body) {
    const status = String(body.status ?? "").toLowerCase();
    if (!LEAD_STATUSES.includes(status)) throw clientError(`status must be one of ${LEAD_STATUSES.join(", ")}.`);
    if (!body.leadId) throw clientError("leadId is required.");
    return this.db.transaction(async (client) => {
      const r = await client.query(`
        update leads set status = $3, notes = coalesce($4, notes), updated_at = now()
        where tenant_id = $1::uuid and id = $2::uuid returning id::text, contact_id::text
      `, [tenantId, body.leadId, status, body.notes ?? null]);
      if (!r.rows.length) throw Object.assign(new Error("Lead not found."), { statusCode: 404 });
      if (status === "lost" || status === "booked") await exitLeadSequences(client, tenantId, r.rows[0].contact_id, status);
      return { updated: true, leadId: r.rows[0].id, status };
    });
  }
}
