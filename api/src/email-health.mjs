// Is the email automation wired up, and is it actually delivering?
//   not_configured — transport isn't Resend, or RESEND_API_KEY / EMAIL_FROM missing
//   error          — configured, but every recent email send failed
//   connected      — configured and delivering (or nothing sent yet)
// Never returns the API key itself, only whether one is present.

export function emailConfigStatus(env = process.env) {
  const transport = String(env.MESSAGE_TRANSPORT_EMAIL ?? "").trim().toLowerCase();
  const hasKey = Boolean(env.RESEND_API_KEY);
  const from = env.EMAIL_FROM || env.MAIL_FROM || "";
  // The email channel only actually reaches Resend when MESSAGE_TRANSPORT_EMAIL
  // is exactly "resend"; anything else (including unset) routes to the no-op
  // transport and every email is recorded as "stubbed".
  if (transport !== "resend") {
    return {
      configured: false,
      reason: transport
        ? `MESSAGE_TRANSPORT_EMAIL is "${transport}", must be "resend"`
        : "MESSAGE_TRANSPORT_EMAIL is not set to \"resend\" (emails are being stubbed, not sent)"
    };
  }
  if (!hasKey) return { configured: false, reason: "RESEND_API_KEY is not set on the API" };
  if (!from) return { configured: false, reason: "EMAIL_FROM (or MAIL_FROM) is not set on the API" };
  return { configured: true };
}

export async function emailAutomationHealth(db, env = process.env, tenantId) {
  const cfg = emailConfigStatus(env);
  const base = {
    provider: "resend",
    from: env.EMAIL_FROM || env.MAIL_FROM || null,
    replyTo: env.REPLY_TO_EMAIL || null,
    apiKeyPresent: Boolean(env.RESEND_API_KEY)
  };
  if (!cfg.configured) return { status: "not_configured", detail: cfg.reason, ...base };

  let recent = { failed: 0, sent: 0, queued: 0, total: 0 };
  if (db && tenantId) {
    try {
      recent = (await db.query(`
        select
          count(*) filter (where delivery_status = 'failed')::int as failed,
          count(*) filter (where delivery_status = 'sent')::int   as sent,
          count(*) filter (where delivery_status = 'queued')::int as queued,
          count(*)::int as total
        from messages
        where tenant_id = $1::uuid and channel = 'email'
          and created_at > now() - interval '24 hours'
      `, [tenantId])).rows[0] || recent;
    } catch { /* health must never throw */ }
  }

  const status = recent.total >= 3 && recent.sent === 0 && recent.failed === recent.total
    ? "error"
    : "connected";
  const detail = status === "error"
    ? `${recent.failed} email(s) failed in the last 24h and none were sent`
    : undefined;
  return { status, detail, recent, ...base };
}
