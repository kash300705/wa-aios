// Retell platform webhook. Retell POSTs call_started / call_ended /
// call_analyzed events with the recording URL, full transcript and structured
// post-call analysis. This is the source of truth for call records — the
// in-call `call_summary` tool is a best-effort fallback only.
//
// Auth: the X-Retell-Signature header, verified with RETELL_API_KEY exactly as
// retell-sdk's `Retell.verify` does — see verifyRetellSignature below. The
// shared x-retell-webhook-secret is a fallback for our own tooling only; Retell
// never sends it. RETELL_API_KEY must be the key that carries the "Webhook"
// badge in the Retell dashboard.

import { createHmac, timingSafeEqual } from "node:crypto";
import { normalisePhone, firstNameOf } from "./leads.mjs";
import { renderMessageTemplate, emailTypeEnabled } from "./messaging-templates.mjs";
import { isValidEmail } from "./dispatcher.mjs";

const OUTCOME_MAP = {
  booked: "booked",
  appointment_booked: "booked",
  rescheduled: "rescheduled",
  cancelled: "cancelled",
  canceled: "cancelled",
  question_answered: "inquiry",
  inquiry: "inquiry",
  transferred: "transferred",
  complaint: "complaint",
  callback_requested: "callback",
  callback: "callback",
  voicemail: "voicemail",
  abandoned: "missed",
  spam: "spam"
};

const RETELL_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a Retell webhook signature exactly as `retell-sdk`'s `Retell.verify`
 * does (retell-sdk >= 5). The `X-Retell-Signature` header is
 *
 *     v=<unix_ms_timestamp>,d=<hmac_sha256_hex>
 *
 * where the digest is HMAC-SHA256, keyed with the Retell API key (the one
 * carrying the "Webhook" badge in the Retell dashboard), over the string
 * `<raw request body><timestamp>`. A ±5 minute timestamp window guards against
 * replay. The legacy plain-hex format (HMAC of the body alone) is still
 * accepted for older signers / local test tooling.
 *
 * `rawBody` MUST be the exact bytes received, not a re-serialised object.
 *
 * @returns {{ ok: boolean, scheme: "timestamped"|"legacy"|"none", reason?: string }}
 */
export function verifyRetellSignature(rawBody, signatureHeader, apiKey, { now = Date.now(), toleranceMs = RETELL_SIGNATURE_TOLERANCE_MS } = {}) {
  if (!apiKey) return { ok: false, scheme: "none", reason: "RETELL_API_KEY is not set" };
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header) return { ok: false, scheme: "none", reason: "missing x-retell-signature header" };
  const signature = String(header).trim();

  const timestamped = /^v=(\d{1,15}),d=([0-9a-f]{64})$/i.exec(signature);
  if (timestamped) {
    const timestampStr = timestamped[1];
    const provided = timestamped[2].toLowerCase();
    const timestamp = Number(timestampStr);
    if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceMs) {
      return { ok: false, scheme: "timestamped", reason: "timestamp outside the 5-minute window" };
    }
    const expected = createHmac("sha256", apiKey).update(rawBody + timestampStr).digest("hex");
    const ok = safeEqualHex(expected, provided);
    return { ok, scheme: "timestamped", reason: ok ? undefined : "digest mismatch" };
  }

  if (/^[0-9a-f]{64}$/i.test(signature)) {
    const expected = createHmac("sha256", apiKey).update(rawBody).digest("hex");
    const ok = safeEqualHex(expected, signature.toLowerCase());
    return { ok, scheme: "legacy", reason: ok ? undefined : "digest mismatch" };
  }

  return { ok: false, scheme: "none", reason: "unrecognised signature format" };
}

export class RetellWebhookService {
  constructor({ db, tenantLoader, leadService, logger = console, env = process.env }) {
    this.db = db;
    this.tenantLoader = tenantLoader;
    this.leads = leadService;
    this.logger = logger;
    this.env = env;
  }

  log(level, event, details = {}) {
    const sink = this.logger?.[level] ?? this.logger?.log;
    if (sink) sink.call(this.logger, JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }));
  }

  async handle(tenantId, payload) {
    const event = payload.event || payload.type || "unknown";
    const call = payload.call || payload.data || payload;
    const callId = call.call_id || call.callId;
    if (!callId) return { ok: false, error: "missing call_id" };

    const tenant = await this.tenantLoader(tenantId);
    const analysis = call.call_analysis || call.analysis || {};
    const custom = analysis.custom_analysis_data || analysis.customAnalysisData || {};

    const startedAt = call.start_timestamp ? new Date(call.start_timestamp) : new Date();
    const endedAt = call.end_timestamp ? new Date(call.end_timestamp) : null;
    const durationSeconds = call.duration_ms
      ? Math.round(call.duration_ms / 1000)
      : endedAt ? Math.max(0, Math.round((endedAt - startedAt) / 1000)) : 0;

    const direction = call.direction === "outbound" ? "outbound" : "inbound";
    const callerNumber = normalisePhone(direction === "outbound" ? call.to_number : call.from_number)
      || normalisePhone(custom.user_phone);

    const rawOutcome = String(custom.outcome || "").toLowerCase();
    const outcome = OUTCOME_MAP[rawOutcome]
      || (custom.appointment_booked ? "booked" : null)
      || (analysis.in_voicemail ? "voicemail" : null)
      || (call.disconnection_reason === "dial_no_answer" ? "missed" : null)
      || "inquiry";

    const answered = event !== "call_started"
      ? !(["missed", "voicemail"].includes(outcome)) && durationSeconds > 0
      : true;

    const result = await this.db.transaction(async (tx) => {
      let contactId = null;
      let linkedAppointmentId = null;

      // 1. The strongest link: an appointment booked DURING this call already
      //    resolved the customer. Use that same contact so the call attaches to
      //    the customer's real history (web/phone calls often have an unreliable
      //    from_number, which otherwise creates a second orphaned contact).
      const bookedInCall = (await tx.query(
        "select id::text, contact_id::text from appointments where tenant_id = $1::uuid and retell_call_id = $2 order by created_at desc limit 1",
        [tenant.id, callId]
      )).rows[0];
      if (bookedInCall) {
        contactId = bookedInCall.contact_id;
        linkedAppointmentId = bookedInCall.id;
        // Backfill the caller's phone onto that contact if it has none yet.
        if (callerNumber) {
          await tx.query(
            "update contacts set phone_e164 = coalesce(phone_e164, $2), updated_at = now() where id = $1::uuid and (phone_e164 is null or phone_e164 = '')",
            [contactId, callerNumber]
          );
        }
      }

      // 2. Otherwise match / create by the caller's number or email.
      if (!contactId && (callerNumber || custom.user_email)) {
        const email = String(custom.user_email || "").trim().toLowerCase();
        const existing = callerNumber
          ? (await tx.query("select id::text, first_name from contacts where tenant_id = $1::uuid and phone_e164 = $2", [tenant.id, callerNumber])).rows[0]
          : (email ? (await tx.query("select id::text, first_name from contacts where tenant_id = $1::uuid and lower(email) = $2", [tenant.id, email])).rows[0] : null);
        if (existing) {
          contactId = existing.id;
          if (custom.user_name && (!existing.first_name || existing.first_name === "Gast")) {
            await tx.query("update contacts set first_name = $2, updated_at = now() where id = $1::uuid", [contactId, firstNameOf(custom.user_name)]);
          }
        } else if (callerNumber) {
          contactId = (await tx.query(`
            insert into contacts (tenant_id, first_name, phone_e164, email, source, whatsapp_consent, email_consent,
                                  lifecycle_stage, last_interaction_at, last_interaction_kind)
            values ($1::uuid, $2, $3, nullif($4,''), 'call', false, ($4 <> ''), 'lead', $5::timestamptz, 'call')
            on conflict (tenant_id, phone_e164) do update set updated_at = now()
            returning id::text
          `, [tenant.id, firstNameOf(custom.user_name), callerNumber, email, startedAt.toISOString()])).rows[0].id;
        }
      }

      const transcript = typeof call.transcript === "string" ? call.transcript : null;
      const row = await tx.query(`
        insert into calls (
          tenant_id, contact_id, retell_call_id, started_at, ended_at, duration_seconds,
          answered, outcome, direction, from_number, to_number, transcript, transcript_object,
          recording_url, disclosure_played, summary, sentiment, user_sentiment, call_successful,
          in_voicemail, disconnection_reason, analysis, cost_cents, appointment_id
        ) values (
          $1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::int,
          $7::boolean, $8, $9, $10, $11, nullif($12,''), $13::jsonb,
          nullif($14,''), $15::boolean, nullif($16,''), $17, $18, $19::boolean,
          $20::boolean, $21, $22::jsonb, $23::int, $24::uuid
        )
        on conflict (tenant_id, retell_call_id) do update set
          contact_id = coalesce(excluded.contact_id, calls.contact_id),
          appointment_id = coalesce(excluded.appointment_id, calls.appointment_id),
          ended_at = coalesce(excluded.ended_at, calls.ended_at),
          duration_seconds = greatest(excluded.duration_seconds, calls.duration_seconds),
          answered = excluded.answered or calls.answered,
          outcome = case when calls.outcome in ('missed','inquiry') then excluded.outcome else calls.outcome end,
          transcript = coalesce(excluded.transcript, calls.transcript),
          transcript_object = coalesce(excluded.transcript_object, calls.transcript_object),
          recording_url = coalesce(excluded.recording_url, calls.recording_url),
          disclosure_played = excluded.disclosure_played or calls.disclosure_played,
          summary = coalesce(excluded.summary, calls.summary),
          sentiment = coalesce(excluded.sentiment, calls.sentiment),
          user_sentiment = coalesce(excluded.user_sentiment, calls.user_sentiment),
          call_successful = coalesce(excluded.call_successful, calls.call_successful),
          in_voicemail = coalesce(excluded.in_voicemail, calls.in_voicemail),
          disconnection_reason = coalesce(excluded.disconnection_reason, calls.disconnection_reason),
          analysis = calls.analysis || excluded.analysis,
          cost_cents = coalesce(excluded.cost_cents, calls.cost_cents),
          from_number = coalesce(excluded.from_number, calls.from_number),
          to_number = coalesce(excluded.to_number, calls.to_number)
        returning id::text, contact_id::text
      `, [
        tenant.id, contactId, callId, startedAt.toISOString(), endedAt ? endedAt.toISOString() : null, durationSeconds,
        answered, outcome, direction, callerNumber || null, normalisePhone(call.to_number) || null,
        transcript || "", call.transcript_object ? JSON.stringify(call.transcript_object) : null,
        call.recording_url || "", custom.disclosure_played === true || custom.disclosure_played === "true",
        analysis.call_summary || custom.summary || "", analysis.sentiment || null, analysis.user_sentiment || null,
        typeof analysis.call_successful === "boolean" ? analysis.call_successful : null,
        typeof analysis.in_voicemail === "boolean" ? analysis.in_voicemail : null,
        call.disconnection_reason || null,
        JSON.stringify({ event, custom, agent_id: call.agent_id, public_log_url: call.public_log_url }),
        call.call_cost?.combined_cost != null ? Math.round(Number(call.call_cost.combined_cost)) : null,
        linkedAppointmentId
      ]);

      const persisted = row.rows[0];

      if (contactId && event !== "call_started") {
        await tx.query(`
          update contacts set last_interaction_at = greatest(coalesce(last_interaction_at,'-infinity'::timestamptz), $2::timestamptz),
                              last_interaction_kind = 'call', updated_at = now()
          where id = $1::uuid
        `, [contactId, startedAt.toISOString()]);
        await tx.query(`
          insert into contact_notes (tenant_id, contact_id, author, kind, body, metadata)
          values ($1::uuid, $2::uuid, 'ai', 'call', $3, $4::jsonb)
        `, [tenant.id, contactId,
            `Call (${outcome}, ${durationSeconds}s): ${(analysis.call_summary || custom.summary || "no summary").slice(0, 200)}`,
            JSON.stringify({ callId: persisted.id, retellCallId: callId, recordingUrl: call.recording_url || null })]);
      }

      await tx.query(`
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
        values ($1::uuid, 'call', $2::uuid, $3, 'retell.webhook', $4::jsonb)
      `, [tenant.id, persisted.id, `call.${event}`, JSON.stringify({ outcome, direction, durationSeconds })]);

      return { callDbId: persisted.id, contactId, outcome };
    });

    // Missed / abandoned / voicemail call, and we hold a valid email for the
    // contact → send a single "sorry we missed you" email. Independent of the
    // lead path below; idempotent per (call, template) via a unique index.
    if (event === "call_analyzed" && result.contactId && ["missed", "voicemail"].includes(result.outcome)) {
      try {
        await this.sendMissedCallEmail(tenant, result.callDbId, result.contactId);
      } catch (error) {
        this.log("warn", "missed_call_email_failed", { message: error.message, callId });
      }
    }

    // A completed call that did NOT book, from a reachable caller, becomes a
    // lead so the standard follow-up ladder chases it.
    if (
      event === "call_analyzed"
      && this.leads
      && callerNumber
      && ["inquiry", "callback", "missed", "voicemail"].includes(result.outcome)
      && !custom.complaint_raised
    ) {
      try {
        await this.leads.createLead(tenant.id, {
          source: "call",
          name: custom.user_name || "",
          phone: callerNumber,
          email: custom.user_email || undefined,
          serviceInterest: custom.service || undefined,
          urgency: "this_week",
          notes: `From phone call ${callId}. ${(analysis.call_summary || "").slice(0, 300)}`
        });
      } catch (error) {
        this.log("warn", "retell_call_lead_failed", { message: error.message, callId });
      }
    }

    this.log("info", "retell_webhook_handled", { event, callId, outcome: result.outcome, contactLinked: Boolean(result.contactId) });
    return { ok: true, event, callId, ...result };
  }

  /** Queue one operational "sorry we missed your call" email if — and only if —
   *  the contact has a valid, consented email address and the type is enabled.
   *  Never throws for a missing/invalid email; that path simply does nothing. */
  async sendMissedCallEmail(tenant, callDbId, contactId) {
    if (!emailTypeEnabled(tenant, "missedCall")) return { sent: false, reason: "disabled" };
    const contact = (await this.db.query(
      "select first_name, email, email_consent from contacts where id = $1::uuid and tenant_id = $2::uuid",
      [contactId, tenant.id]
    )).rows[0];
    if (!contact?.email || !isValidEmail(contact.email) || contact.email_consent !== true) {
      return { sent: false, reason: "no_valid_email" };
    }
    const rendered = renderMessageTemplate({
      tenant,
      templateId: "missed_call",
      contact: { first_name: contact.first_name }
    });
    const row = await this.db.query(`
      insert into messages (
        tenant_id, contact_id, call_id, channel, direction, body, subject,
        template_id, delivery_status, scheduled_for
      ) values ($1::uuid, $2::uuid, $3::uuid, 'email', 'outbound', $4, $5, 'missed_call', 'queued', now())
      on conflict do nothing
      returning id::text
    `, [tenant.id, contactId, callDbId, rendered.body, rendered.subject || null]);
    return { sent: row.rows.length > 0 };
  }
}
