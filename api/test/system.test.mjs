import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createRuntime } from "../server.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const webhookSecret = "system-test-secret";
const dashboardToken = "system-test-dash";
const retellApiKey = "key_system_test_webhook";

/** Sign a body the way retell-sdk's Retell.verify expects: v=<ms>,d=<hmac(body+ms)>. */
function retellSignature(body, apiKey = retellApiKey, ts = Date.now()) {
  const digest = createHmac("sha256", apiKey).update(body + ts).digest("hex");
  return `v=${ts},d=${digest}`;
}
let runtime;
let socketPath;

// Deterministic stub for the Anthropic client. Replies with a fixed line and
// never calls tools, so the conversation + reactivation paths are exercised
// without a network call.
const stubAi = {
  enabled: true,
  model: "stub",
  async complete() {
    return {
      text: "Thanks for the message — we have space on Thursday at 2pm, shall I book that for you?",
      toolUses: [],
      stopReason: "end_turn",
      raw: { content: [{ type: "text", text: "stub" }] }
    };
  }
};

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

async function webhook(endpoint, payload) {
  const body = JSON.stringify(payload);
  const res = await req(`/webhook/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-retell-webhook-secret": webhookSecret },
    body
  });
  assert.equal(res.status, 200, `${endpoint} → ${res.status}: ${res.text}`);
  return JSON.parse(res.text);
}

async function dash(pathname, { method = "GET", body } = {}) {
  const payload = body ? JSON.stringify(body) : undefined;
  const res = await req(pathname, {
    method,
    headers: {
      authorization: `Bearer ${dashboardToken}`,
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
    },
    body: payload
  });
  assert.equal(res.status, 200, `${pathname} → ${res.status}: ${res.text}`);
  return JSON.parse(res.text);
}

const q = (text, params) => runtime.db.query(text, params);

before(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wa-aios-sys-"));
  socketPath = `/tmp/wa-aios-sys-${process.pid}.sock`;
  runtime = await createRuntime({
    dataDir,
    socketPath,
    calendarProvider: "local",
    databaseUrl: "",
    ai: stubAi,
    env: { ...process.env, RETELL_WEBHOOK_SECRET: webhookSecret, RETELL_API_KEY: retellApiKey, DASHBOARD_API_TOKEN: dashboardToken, RATE_LIMIT_MAX: "999" },
    logger: { log() {}, error() {} }
  });
  await runtime.start();
});

after(async () => { if (runtime) await runtime.close(); });

test("Retell webhook: call_analyzed persists the recording, transcript and outcome and links a contact", async () => {
  const callId = `call_${randomUUID()}`;
  const out = await webhook("retell", {
    event: "call_analyzed",
    call: {
      call_id: callId,
      direction: "inbound",
      from_number: "+41794440500",
      to_number: "+41445550124",
      start_timestamp: Date.now() - 180_000,
      end_timestamp: Date.now(),
      duration_ms: 180_000,
      transcript: "Agent: Hello\nUser: I want to book a cut",
      recording_url: "https://recordings.example/abc.wav",
      disconnection_reason: "user_hangup",
      call_analysis: {
        call_summary: "Caller asked about a cut and colour, did not book.",
        user_sentiment: "Positive",
        call_successful: true,
        custom_analysis_data: { outcome: "question_answered", disclosure_played: true, user_name: "Priya", service: "Cut & Finish" }
      }
    }
  });
  assert.equal(out.ok, true);
  const call = (await q(`select * from calls where tenant_id = $1::uuid and retell_call_id = $2`, [tenantId, callId])).rows[0];
  assert.equal(call.recording_url, "https://recordings.example/abc.wav");
  assert.equal(call.outcome, "inquiry");
  assert.equal(call.disclosure_played, true);
  assert.match(call.transcript, /I want to book a cut/);
  assert.ok(call.contact_id, "call is linked to a contact");
  const contact = (await q(`select first_name, last_interaction_kind from contacts where id = $1::uuid`, [call.contact_id])).rows[0];
  assert.equal(contact.first_name, "Priya");
  assert.equal(contact.last_interaction_kind, "call");
  // Unbooked inquiry → follow-up ladder started.
  const followUps = (await q(
    `select count(*)::int as n from messages where contact_id = $1::uuid and template_id like 'lead_%'`, [call.contact_id]
  )).rows[0].n;
  assert.ok(followUps >= 1, "an unbooked call becomes a lead with follow-ups");
});

test("Retell webhook: a call that booked in-call links to the SAME contact as the appointment", async () => {
  const callId = `call_${randomUUID()}`;
  // 1. the receptionist books during the call (tool body carries call metadata)
  const day = new Date();
  day.setDate(day.getDate() + 9);
  while (day.getDay() !== 3) day.setDate(day.getDate() + 1); // a Wednesday (tenant open)
  const startIso = `${day.toISOString().slice(0, 10)}T09:00:00+02:00`;
  const booked = await webhook("book-appointment", {
    startTime: startIso, serviceId: "Men's Cut",
    customerName: "Web Caller", customerPhone: "", // web test call: no caller number
    call: { call_id: callId, from_number: "web_call" }
  });
  assert.equal(booked.status, "booked", JSON.stringify(booked));
  const appt = (await q(`select id::text, contact_id::text, retell_call_id from appointments where id = $1::uuid`, [booked.appointmentId])).rows[0];
  assert.equal(appt.retell_call_id, callId, "appointment stores the call id");

  const contactsBefore = (await q(`select count(*)::int n from contacts where tenant_id = $1::uuid`, [tenantId])).rows[0].n;

  // 2. call_analyzed arrives with an unreliable from_number
  await webhook("retell", {
    event: "call_analyzed",
    call: {
      call_id: callId, direction: "inbound", from_number: "+0",
      start_timestamp: Date.now() - 120_000, end_timestamp: Date.now(), duration_ms: 120_000,
      transcript: "Agent: Thanks for calling\nUser: I'd like a men's cut\nAgent: Booked.",
      recording_url: "https://rec.example/wc.wav",
      call_analysis: { call_summary: "Booked a men's cut.", custom_analysis_data: { outcome: "booked", appointment_booked: true, disclosure_played: true, user_name: "Web Caller" } }
    }
  });

  const contactsAfter = (await q(`select count(*)::int n from contacts where tenant_id = $1::uuid`, [tenantId])).rows[0].n;
  assert.equal(contactsAfter, contactsBefore, "no orphaned second contact was created from '+0'");

  const call = (await q(`select contact_id::text, appointment_id::text, transcript, recording_url from calls where tenant_id = $1::uuid and retell_call_id = $2`, [tenantId, callId])).rows[0];
  assert.equal(call.contact_id, appt.contact_id, "call attaches to the appointment's contact");
  assert.equal(call.appointment_id, appt.id, "call links back to the appointment");
  assert.match(call.transcript, /men's cut/);
  assert.equal(call.recording_url, "https://rec.example/wc.wav");

  // the customer 360 shows both the appointment and the call
  const dash = await dash_customer(appt.contact_id);
  assert.ok(dash.appointments.some((a) => a.id === appt.id));
  assert.ok(dash.calls.some((k) => k.retell_call_id === callId && k.transcript));
});

async function dash_customer(id) {
  return dash(`/api/dashboard/customer?id=${id}`);
}

test("Retell webhook: a valid X-Retell-Signature is accepted, a bad one is 401", async () => {
  const callId = `call_${randomUUID()}`;
  const body = JSON.stringify({
    event: "call_analyzed",
    call: {
      call_id: callId, direction: "inbound", from_number: "+41794440777",
      start_timestamp: Date.now() - 60_000, end_timestamp: Date.now(), duration_ms: 60_000,
      transcript: "Agent: Hi\nUser: bye", recording_url: "https://rec.example/x.wav",
      call_analysis: { call_summary: "quick call", custom_analysis_data: { outcome: "question_answered", disclosure_played: true } }
    }
  });

  const good = await req("/webhook/retell", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-retell-signature": retellSignature(body) },
    body
  });
  assert.equal(good.status, 200, good.text);
  assert.equal(JSON.parse(good.text).received, true);

  const bad = await req("/webhook/retell", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-retell-signature": `v=${Date.now()},d=${"0".repeat(64)}` },
    body
  });
  assert.equal(bad.status, 401);

  const stale = await req("/webhook/retell", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-retell-signature": retellSignature(body, retellApiKey, Date.now() - 20 * 60_000) },
    body
  });
  assert.equal(stale.status, 401, "a 20-minute-old signature is rejected as replay");

  const call = (await q(`select retell_call_id from calls where retell_call_id = $1`, [callId])).rows[0];
  assert.ok(call, "the signed call was persisted");
});

test("Inbound message stops the follow-up ladder the moment the customer replies", async () => {
  const lead = await webhook("lead", { source: "website", name: "Marco Bianchi", email: "marco@example.ch", phone: "+41794440501", serviceInterest: "Balayage" });
  assert.equal(lead.followUpsScheduled, 5);
  const queuedBefore = (await q(
    `select count(*)::int as n from messages where contact_id = $1::uuid and delivery_status = 'queued'`, [lead.contactId]
  )).rows[0].n;
  assert.ok(queuedBefore >= 4);

  const reply = await webhook("inbound-message", { channel: "email", email: "marco@example.ch", text: "Yes, do you have anything Friday afternoon?" });
  assert.equal(reply.handled, true);
  assert.ok(reply.sequencesStopped >= 3, "queued ladder messages were cancelled");
  assert.equal(reply.aiReplied, true);

  const queuedAfter = (await q(
    `select count(*)::int as n from messages where contact_id = $1::uuid and template_id like 'lead_%' and delivery_status = 'queued'`, [lead.contactId]
  )).rows[0].n;
  assert.equal(queuedAfter, 0);
  const runs = (await q(
    `select count(*)::int as n from sequence_runs where contact_id = $1::uuid and status = 'active' and sequence_type in ('lead_follow_up','re_engagement')`, [lead.contactId]
  )).rows[0].n;
  assert.equal(runs, 0);
  const convo = (await q(`select status from conversations where contact_id = $1::uuid`, [lead.contactId])).rows[0];
  assert.ok(["ai_handling", "open", "closed"].includes(convo.status));
  const aiMsg = (await q(
    `select count(*)::int as n from messages where contact_id = $1::uuid and direction = 'outbound' and ai_generated = true`, [lead.contactId]
  )).rows[0].n;
  assert.ok(aiMsg >= 1);
});

test("Reactivation: preview → create → launch schedules personalised messages and a reply stops them", async () => {
  // Seed a lapsed customer directly.
  const contactId = randomUUID();
  await q(`
    insert into contacts (id, tenant_id, first_name, last_name, email, source, email_consent,
                          lifecycle_stage, completed_bookings, total_bookings, last_booked_at, first_booked_at, lifetime_value_chf, last_interaction_at)
    values ($1::uuid, $2::uuid, 'Elena', 'Rossi', 'elena@example.ch', 'call', true,
            'inactive', 3, 3, now() - interval '210 days', now() - interval '600 days', 384, now() - interval '210 days')
  `, [contactId, tenantId]);
  const apptId = randomUUID();
  await q(`
    insert into appointments (id, tenant_id, contact_id, external_id, platform, status, status_source,
      starts_at, ends_at, service, value_chf, staff, staff_calendar_id, lead_source)
    values ($1::uuid, $2::uuid, $3::uuid, $4, 'local', 'completed', 'inferred',
      now() - interval '210 days', now() - interval '210 days' + interval '1 hour', 'Balayage', 128, 'Lea', 'primary', 'call')
  `, [apptId, tenantId, contactId, `local-${randomUUID()}`]);

  const preview = await dash("/api/dashboard/reactivation-preview", { method: "POST", body: { criteria: { inactiveDays: 90, minCompletedBookings: 2 } } });
  assert.ok(preview.total >= 1, `preview found ${preview.total}`);
  assert.ok(preview.sample.some((s) => s.name.includes("Elena")));

  const created = await dash("/api/dashboard/reactivation-create", {
    method: "POST",
    body: { name: "Winter win-back", channel: "email", offer: "20% off your next colour", criteria: { inactiveDays: 90, minCompletedBookings: 2 } }
  });
  assert.ok(created.totalTargeted >= 1);

  const launched = await dash("/api/dashboard/reactivation-launch", { method: "POST", body: { campaignId: created.campaignId } });
  assert.ok(launched.messagesScheduled >= 1);

  const target = (await q(`
    select t.status, t.personalised_body, m.template_id, m.delivery_status
    from reactivation_targets t join messages m on m.id = t.message_id
    where t.campaign_id = $1::uuid and t.contact_id = $2::uuid
  `, [created.campaignId, contactId])).rows[0];
  assert.equal(target.status, "queued");
  assert.equal(target.template_id, "reactivation_intro");
  assert.ok(target.personalised_body && target.personalised_body.length > 10);

  const run = (await q(
    `select count(*)::int as n from sequence_runs where contact_id = $1::uuid and sequence_type = 'reactivation' and status = 'active'`, [contactId]
  )).rows[0].n;
  assert.equal(run, 1);

  // Customer replies → campaign message cancelled, target marked responded.
  const reply = await webhook("inbound-message", { channel: "email", email: "elena@example.ch", text: "Ooh yes please, Saturday morning?" });
  assert.equal(reply.handled, true);
  const after = (await q(`
    select t.status as target_status, m.delivery_status,
           (select status from sequence_runs where contact_id = $1::uuid and sequence_type = 'reactivation' order by started_at desc limit 1) as run_status
    from reactivation_targets t join messages m on m.id = t.message_id
    where t.contact_id = $1::uuid
  `, [contactId])).rows[0];
  assert.equal(after.target_status, "responded");
  assert.equal(after.delivery_status, "failed");
  assert.equal(after.run_status, "exited");
});

test("Dashboard API: customers, customer 360, follow-ups, analytics and settings return usable shapes", async () => {
  const customers = await dash("/api/dashboard/customers?limit=5");
  assert.ok(Array.isArray(customers.customers));
  assert.ok(Array.isArray(customers.segments));
  const withHistory = customers.customers.find((c) => c.total_bookings > 0) || customers.customers[0];
  assert.ok(withHistory, "at least one customer exists");

  const detail = await dash(`/api/dashboard/customer?id=${withHistory.id}`);
  assert.ok(detail.contact);
  assert.ok(Array.isArray(detail.appointments));
  assert.ok(Array.isArray(detail.notes));
  assert.ok(Array.isArray(detail.messages));

  const note = await dash("/api/dashboard/notes", { method: "POST", body: { contactId: withHistory.id, body: "VIP — always books with Lea." } });
  assert.equal(note.created, true);
  const detail2 = await dash(`/api/dashboard/customer?id=${withHistory.id}`);
  assert.ok(detail2.notes.some((n) => n.body.includes("VIP")));

  const followups = await dash("/api/dashboard/followups");
  assert.ok(Array.isArray(followups.active));
  assert.ok(Array.isArray(followups.summary));

  const analytics = await dash("/api/dashboard/analytics?days=30");
  assert.equal(analytics.series.length, 30);
  assert.ok(analytics.totals);
  assert.ok("revenue" in analytics.totals);

  const settings = await dash("/api/dashboard/settings");
  assert.equal(settings.tenant.id, tenantId);
  assert.ok(Array.isArray(settings.tenant.services));

  const upd = await dash("/api/dashboard/settings-update", { method: "POST", body: { quietHours: { start: "22:00", end: "07:00" } } });
  assert.equal(upd.updated, true);
  const settings2 = await dash("/api/dashboard/settings");
  assert.equal(settings2.tenant.quietHours.start, "22:00");
});

test("Dashboard write: appointment outcome marks completion and rolls the customer up", async () => {
  const appts = await dash("/api/dashboard/appointments?scope=upcoming&limit=1");
  let target = appts.appointments[0];
  if (!target) {
    const contactId = (await q(`select id::text from contacts where tenant_id = $1::uuid limit 1`, [tenantId])).rows[0].id;
    const apptId = randomUUID();
    await q(`
      insert into appointments (id, tenant_id, contact_id, external_id, platform, status, status_source,
        starts_at, ends_at, service, value_chf, staff, staff_calendar_id, lead_source)
      values ($1::uuid,$2::uuid,$3::uuid,$4,'local','booked','workflow',
        now() + interval '1 day', now() + interval '1 day' + interval '1 hour', 'Cut & Finish', 118, 'Lea', 'primary', 'call')
    `, [apptId, tenantId, contactId, `local-${randomUUID()}`]);
    target = { id: apptId, contact_id: contactId };
  }
  const res = await dash("/api/dashboard/appointment-outcome", { method: "POST", body: { appointmentId: target.id, outcome: "completed" } });
  assert.equal(res.updated, true);
  const state = (await q(`select status, status_source from appointments where id = $1::uuid`, [target.id])).rows[0];
  assert.equal(state.status, "completed");
  assert.equal(state.status_source, "staff");
});
