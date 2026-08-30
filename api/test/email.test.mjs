// Operational email automation — end to end through the real runtime:
//   booking / reschedule / cancel / missed-call / lead → messages queue →
//   MessageDispatcher → (stubbed) Resend → messages + email_events updated.
// A stub fetch stands in for api.resend.com so no real email is sent.

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHmac } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { createRuntime } from "../server.mjs";
import { addDateKey, localDateKey, weekdayForDateKey, zonedDateTime, swissHolidaySet } from "../src/time.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const timezone = "Europe/Zurich";
const webhookSecret = "email-test-secret";
const dashboardToken = "email-test-dash";
const retellApiKey = "key_email_test";

let runtime;
let socketPath;
let resend; // { calls: [...], mode: "ok" | "fail" }

const stubAi = { enabled: false, model: "stub", async complete() { return { text: "", toolUses: [], stopReason: "end_turn", raw: {} }; } };

/** fetch stub: intercept Resend, delegate everything else to real fetch. */
function makeFetch() {
  return async (url, init = {}) => {
    if (String(url).startsWith("https://api.resend.com/emails")) {
      const body = JSON.parse(init.body || "{}");
      resend.calls.push({ body, headers: init.headers });
      if (resend.mode === "fail") {
        return { ok: false, status: 500, statusText: "Internal Server Error", text: async () => "resend is down" };
      }
      return { ok: true, status: 200, json: async () => ({ id: `resend_${randomUUID()}` }), text: async () => "{}" };
    }
    return fetch(url, init);
  };
}

function req(pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    r.end(body);
  });
}
async function tool(endpoint, payload, expect = 200) {
  const s = JSON.stringify(payload);
  const res = await req(`/webhook/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(s), "x-retell-webhook-secret": webhookSecret },
    body: s
  });
  assert.equal(res.status, expect, `${endpoint} → ${res.status}: ${res.text}`);
  return JSON.parse(res.text);
}
function retellSig(body, ts = Date.now()) {
  return `v=${ts},d=${createHmac("sha256", retellApiKey).update(body + ts).digest("hex")}`;
}
async function retellWebhook(payload) {
  const s = JSON.stringify(payload);
  const res = await req("/webhook/retell", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(s), "x-retell-signature": retellSig(s) },
    body: s
  });
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text);
}
async function dash(pathname) {
  const res = await req(`/api/dashboard/${pathname}`, { headers: { authorization: `Bearer ${dashboardToken}` } });
  return { status: res.status, json: res.status === 200 ? JSON.parse(res.text) : null };
}
const q = (sql, params) => runtime.db.query(sql, params);

function futureBookable(weekday, minDays = 8) {
  const today = localDateKey(new Date(), timezone);
  for (let o = minDays; o < minDays + 60; o += 1) {
    const c = addDateKey(today, o);
    if (weekdayForDateKey(c) !== weekday) continue;
    if (swissHolidaySet(Number(c.slice(0, 4)), "ZH").has(c)) continue;
    if (["2026-12-24", "2026-12-31"].includes(c)) continue;
    return c;
  }
  throw new Error("no bookable day");
}
async function bookOnce({ email, name = "Test Client", phone = null, service = "Men's Cut", weekday = "wednesday", time = "10:00" }) {
  const day = futureBookable(weekday);
  const startTime = zonedDateTime(day, time, timezone).toISOString();
  const res = await tool("book-appointment", { startTime, serviceId: service, customerName: name, customerPhone: phone, customerEmail: email });
  assert.equal(res.status, "booked", `book ${weekday} ${time} → ${JSON.stringify(res)}`);
  return res;
}
async function drain(now = new Date()) {
  return runtime.dispatcher.runOnce({ now });
}

before(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wa-aios-email-"));
  socketPath = `/tmp/wa-aios-email-${process.pid}.sock`;
  resend = { calls: [], mode: "ok" };
  runtime = await createRuntime({
    dataDir,
    socketPath,
    calendarProvider: "local",
    databaseUrl: "",
    ai: stubAi,
    fetchImpl: makeFetch(),
    env: {
      ...process.env,
      RETELL_WEBHOOK_SECRET: webhookSecret,
      RETELL_API_KEY: retellApiKey,
      DASHBOARD_API_TOKEN: dashboardToken,
      RATE_LIMIT_MAX: "999",
      MESSAGE_DISPATCH_BATCH_SIZE: "500",
      MESSAGE_TRANSPORT_EMAIL: "resend",
      RESEND_API_KEY: "re_stub_key",
      EMAIL_FROM: "Atelier Nova <bookings@test.example>",
      REPLY_TO_EMAIL: "hello@test.example"
    },
    logger: { log() {}, info() {}, warn() {}, error() {} }
  });
  await runtime.start();
  // Start from a clean slate: the demo seed ships ~100 queued review emails and
  // future appointments that would otherwise collide with the bookings below.
  await runtime.db.query("delete from message_dispatch_state");
  await runtime.db.query("delete from messages where delivery_status in ('queued', 'failed')");
  await runtime.db.query("delete from local_calendar_events where starts_at > now()");
  await runtime.db.query("delete from appointments where starts_at > now()");
});
after(async () => { if (runtime) await runtime.close(); });
beforeEach(() => { resend.calls = []; resend.mode = "ok"; });

test("1. booking queues exactly one confirmation email, only after the appointment row exists", async () => {
  const email = `conf-${randomUUID().slice(0, 8)}@example.test`;
  const res = await bookOnce({ email, time: "10:00" });
  assert.equal(res.status, "booked");

  const appt = (await q("select id::text, contact_id::text from appointments where id = $1::uuid", [res.appointmentId])).rows[0];
  assert.ok(appt, "appointment persisted");

  const msgs = (await q(
    "select template_id, channel, delivery_status, subject, appointment_id::text from messages where appointment_id = $1::uuid and template_id = 'appointment_confirmation'",
    [res.appointmentId]
  )).rows;
  assert.equal(msgs.length, 1, "one confirmation queued");
  assert.equal(msgs[0].channel, "email");
  assert.equal(msgs[0].delivery_status, "queued");
  assert.ok(msgs[0].subject && msgs[0].subject.length > 0);

  await drain();
  const sent = (await q(
    "select delivery_status, recipient, provider_message_id, sent_at from messages where appointment_id = $1::uuid and template_id = 'appointment_confirmation'",
    [res.appointmentId]
  )).rows[0];
  assert.equal(sent.delivery_status, "sent");
  assert.equal(sent.recipient, email);
  assert.match(sent.provider_message_id || "", /^resend_/);
  assert.ok(sent.sent_at);

  assert.equal(resend.calls.length, 1, "Resend called once");
  const payload = resend.calls[0].body;
  assert.equal(payload.to[0], email);
  assert.equal(payload.reply_to, "hello@test.example");
  assert.ok(payload.html && payload.html.includes("<"), "HTML body present");
  assert.ok(payload.text && payload.text.length > 0, "plain-text alternative present");
  assert.match(resend.calls[0].headers["idempotency-key"], /^wa-aios-message-/);
});

test("2. a duplicate booking webhook does not create a second confirmation email", async () => {
  const email = `dup-${randomUUID().slice(0, 8)}@example.test`;
  const day = futureBookable("wednesday");
  const startTime = zonedDateTime(day, "11:00", timezone).toISOString();
  const payload = { startTime, serviceId: "Men's Cut", customerName: "Dup Client", customerEmail: email };
  const first = await tool("book-appointment", payload);
  assert.equal(first.status, "booked");
  const second = await tool("book-appointment", payload); // same slot again
  assert.equal(second.status, "not_booked");

  const confs = (await q(
    "select count(*)::int as n from messages where template_id = 'appointment_confirmation' and contact_id = (select contact_id from appointments where id = $1::uuid)",
    [first.appointmentId]
  )).rows[0].n;
  assert.equal(confs, 1, "still exactly one confirmation");
});

test("3. reschedule sends one 'appointment moved' email with the new time", async () => {
  const email = `resch-${randomUUID().slice(0, 8)}@example.test`;
  const booked = await bookOnce({ email, time: "13:00" });
  await drain(); // clear the confirmation
  resend.calls = [];

  const day = futureBookable("friday");
  const newStart = zonedDateTime(day, "14:00", timezone).toISOString();
  const r = await tool("reschedule-appointment", { appointmentId: booked.appointmentId, newStartTime: newStart });
  assert.equal(r.status, "rescheduled");

  const msgs = (await q(
    "select delivery_status, body from messages where appointment_id = $1::uuid and template_id = 'appointment_rescheduled'",
    [booked.appointmentId]
  )).rows;
  assert.equal(msgs.length, 1);

  await drain();
  const after = (await q(
    "select delivery_status from messages where appointment_id = $1::uuid and template_id = 'appointment_rescheduled'",
    [booked.appointmentId]
  )).rows[0];
  assert.equal(after.delivery_status, "sent");
  assert.equal(resend.calls.length, 1);
  assert.match(resend.calls[0].body.subject, /moved|rescheduled|verschoben/i);
});

test("4. cancellation sends one cancellation email with the appointment details", async () => {
  const email = `cxl-${randomUUID().slice(0, 8)}@example.test`;
  const booked = await bookOnce({ email, time: "14:00", weekday: "wednesday" });
  await drain();
  resend.calls = [];

  const c = await tool("cancel-appointment", { appointmentId: booked.appointmentId, reason: "changed plans" });
  assert.equal(c.status, "cancelled");

  const msgs = (await q(
    "select delivery_status, body from messages where appointment_id = $1::uuid and template_id = 'appointment_cancelled'",
    [booked.appointmentId]
  )).rows;
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /Men's Cut/);

  await drain();
  assert.equal(resend.calls.length, 1);

  // a duplicate cancel webhook does nothing (appointment already cancelled)
  const again = await tool("cancel-appointment", { appointmentId: booked.appointmentId });
  assert.equal(again.status, "not_found");
  const total = (await q(
    "select count(*)::int as n from messages where appointment_id = $1::uuid and template_id = 'appointment_cancelled'",
    [booked.appointmentId]
  )).rows[0].n;
  assert.equal(total, 1);
});

test("5. a 24h reminder is scheduled ~24h before the appointment", async () => {
  const email = `rem-${randomUUID().slice(0, 8)}@example.test`;
  const day = futureBookable("wednesday");
  const start = zonedDateTime(day, "15:00", timezone);
  const booked = await tool("book-appointment", {
    startTime: start.toISOString(), serviceId: "Men's Cut", customerName: "Reminder Client", customerEmail: email
  });
  const rem = (await q(
    "select channel, scheduled_for from messages where appointment_id = $1::uuid and template_id = 'appointment_t_24h'",
    [booked.appointmentId]
  )).rows[0];
  assert.ok(rem, "24h reminder queued");
  assert.equal(rem.channel, "email");
  const gapHours = (start.getTime() - new Date(rem.scheduled_for).getTime()) / 3_600_000;
  assert.ok(gapHours >= 23 && gapHours <= 25, `24h before (got ${gapHours.toFixed(1)}h)`);
  // 2h reminder structure also present (for the "add a 2nd reminder later" requirement)
  const t2h = (await q(
    "select count(*)::int as n from messages where appointment_id = $1::uuid and template_id = 'appointment_t_2h'",
    [booked.appointmentId]
  )).rows[0].n;
  assert.ok(t2h >= 1);
});

test("6. missed call → follow-up email only when a valid email is on file", async () => {
  // (a) missed call, contact has an email → one missed_call email
  const email = `miss-${randomUUID().slice(0, 8)}@example.test`;
  const withEmail = await retellWebhook({
    event: "call_analyzed",
    call: {
      call_id: `call_${randomUUID()}`, direction: "inbound", from_number: "+41794440777",
      start_timestamp: Date.now() - 20_000, end_timestamp: Date.now(), duration_ms: 20_000,
      disconnection_reason: "dial_no_answer",
      call_analysis: { custom_analysis_data: { outcome: "abandoned", user_email: email, user_name: "Missed Caller" } }
    }
  });
  assert.equal(withEmail.outcome, "missed");
  const m1 = (await q(
    "select count(*)::int as n from messages where call_id = $1::uuid and template_id = 'missed_call'",
    [withEmail.callDbId]
  )).rows[0].n;
  assert.equal(m1, 1, "one missed_call email queued");

  // duplicate webhook → still one
  await retellWebhook({
    event: "call_analyzed",
    call: {
      call_id: (await q("select retell_call_id from calls where id = $1::uuid", [withEmail.callDbId])).rows[0].retell_call_id,
      direction: "inbound", from_number: "+41794440777",
      start_timestamp: Date.now() - 20_000, end_timestamp: Date.now(), duration_ms: 20_000,
      disconnection_reason: "dial_no_answer",
      call_analysis: { custom_analysis_data: { outcome: "abandoned", user_email: email } }
    }
  });
  const m1b = (await q("select count(*)::int as n from messages where call_id = $1::uuid and template_id = 'missed_call'", [withEmail.callDbId])).rows[0].n;
  assert.equal(m1b, 1, "no duplicate missed_call email");

  // (b) missed call, NO email anywhere → no missed_call email
  const noEmail = await retellWebhook({
    event: "call_analyzed",
    call: {
      call_id: `call_${randomUUID()}`, direction: "inbound", from_number: "+41794440888",
      start_timestamp: Date.now() - 15_000, end_timestamp: Date.now(), duration_ms: 15_000,
      disconnection_reason: "dial_no_answer",
      call_analysis: { custom_analysis_data: { outcome: "abandoned" } }
    }
  });
  const m2 = (await q("select count(*)::int as n from messages where call_id = $1::uuid and template_id = 'missed_call'", [noEmail.callDbId])).rows[0].n;
  assert.equal(m2, 0, "no email address → no missed_call email");
});

test("7. lead follow-up: an email lead gets exactly one, with no duplicates on a repeat webhook", async () => {
  const email = `lead-${randomUUID().slice(0, 8)}@example.test`;
  const first = await tool("lead", { source: "website", name: "Lead One", email, serviceInterest: "Balayage" });
  assert.equal(first.followUpsScheduled, 1);
  await tool("lead", { source: "website", name: "Lead One", email, serviceInterest: "Balayage" }); // repeat
  const n = (await q(
    "select count(*)::int as n from messages where contact_id = $1::uuid and template_id = 'lead_followup' and delivery_status = 'queued'",
    [first.contactId]
  )).rows[0].n;
  assert.equal(n, 1, "one queued lead_followup after a repeat enquiry");
});

test("8. a Resend outage does not break booking and is logged on the message", async () => {
  resend.mode = "fail";
  const email = `fail-${randomUUID().slice(0, 8)}@example.test`;
  const booked = await bookOnce({ email, time: "16:00", weekday: "wednesday" });
  assert.equal(booked.status, "booked", "booking succeeds even though email will fail");

  // exhaust retries
  for (let i = 0; i < 4; i += 1) await drain(new Date(Date.now() + i * 3_600_000 * 2));
  const row = (await q(
    "select delivery_status, last_error, recipient from messages where appointment_id = $1::uuid and template_id = 'appointment_confirmation'",
    [booked.appointmentId]
  )).rows[0];
  assert.equal(row.delivery_status, "failed");
  assert.match(row.last_error || "", /resend|500/i);
  assert.equal(row.recipient, email);
});

test("9. an invalid email address is rejected before any send, with a clear error", async () => {
  const contact = (await q(
    "insert into contacts (tenant_id, first_name, email, email_consent, source) values ($1::uuid, 'Bad', 'not-an-email', true, 'call') returning id::text",
    [tenantId]
  )).rows[0];
  await q(
    "insert into messages (tenant_id, contact_id, channel, direction, body, subject, template_id, delivery_status, scheduled_for) values ($1::uuid, $2::uuid, 'email', 'outbound', 'hi', 'Hi', 'lead_followup', 'queued', now())",
    [tenantId, contact.id]
  );
  await drain();
  const row = (await q("select delivery_status, last_error from messages where contact_id = $1::uuid", [contact.id])).rows[0];
  assert.equal(row.delivery_status, "failed");
  assert.match(row.last_error || "", /invalid email/i);
  assert.equal(resend.calls.length, 0, "Resend was never called");
});

test("10. email_events view + Customer 360 expose the email activity", async () => {
  const email = `c360-${randomUUID().slice(0, 8)}@example.test`;
  const booked = await bookOnce({ email, time: "09:00", weekday: "wednesday" });
  assert.equal(booked.status, "booked", JSON.stringify(booked));
  await drain();
  const contactId = (await q("select contact_id::text from appointments where id = $1::uuid", [booked.appointmentId])).rows[0].contact_id;

  const view = (await q(
    "select email_type, status, recipient, subject, provider_message_id from email_events where contact_id = $1::uuid order by created_at",
    [contactId]
  )).rows;
  assert.ok(view.some((r) => r.email_type === "appointment_confirmation" && r.status === "sent" && r.recipient === email));

  const res = await dash(`customer?id=${contactId}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.emailActivity), "customer 360 returns emailActivity");
  assert.ok(res.json.emailActivity.some((e) => e.email_type === "appointment_confirmation"));
});

test("11. per-type kill switch: disabling confirmations stops them being queued", async () => {
  await q(
    `update tenants set messaging_config = jsonb_set(coalesce(messaging_config,'{}'::jsonb), '{email}', '{"confirmation": false}'::jsonb, true) where id = $1::uuid`,
    [tenantId]
  );
  try {
    const email = `off-${randomUUID().slice(0, 8)}@example.test`;
    const booked = await bookOnce({ email, time: "12:00", weekday: "wednesday" });
    const n = (await q(
      "select count(*)::int as n from messages where appointment_id = $1::uuid and template_id = 'appointment_confirmation'",
      [booked.appointmentId]
    )).rows[0].n;
    assert.equal(n, 0, "no confirmation queued when disabled");
    // reminders still scheduled
    const rem = (await q(
      "select count(*)::int as n from messages where appointment_id = $1::uuid and template_id = 'appointment_t_24h'",
      [booked.appointmentId]
    )).rows[0].n;
    assert.equal(rem, 1);
  } finally {
    await q(
      `update tenants set messaging_config = messaging_config - 'email' where id = $1::uuid`,
      [tenantId]
    );
  }
});

test("12. /health reports the email automation status", async () => {
  const res = await req("/health");
  const body = JSON.parse(res.text);
  assert.ok(["connected", "not_configured", "error", "unknown"].includes(body.emailAutomation), body.emailAutomation);
  // this runtime is fully configured (key + from) → connected
  assert.equal(body.emailAutomation, "connected");
});

test("13. dashboard settings returns email automation config + status", async () => {
  const res = await dash("settings");
  assert.equal(res.status, 200);
  assert.ok(res.json.emailAutomation, "settings include emailAutomation");
  assert.equal(res.json.emailAutomation.provider, "resend");
  assert.equal(res.json.emailAutomation.from, "Atelier Nova <bookings@test.example>");
  assert.equal(res.json.emailAutomation.apiKeyPresent, true);
  assert.ok(!("apiKey" in res.json.emailAutomation), "never returns the key itself");
});
