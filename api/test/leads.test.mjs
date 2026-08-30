import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createRuntime } from "../server.mjs";
import { addDateKey, localDateKey, weekdayForDateKey, zonedDateTime, swissHolidaySet } from "../src/time.mjs";
import { LEAD_LADDER, leadFromManyChat, normaliseLeadInput, channelForLead } from "../src/leads.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const timezone = "Europe/Zurich";
const webhookSecret = "leads-test-secret";
const dashboardToken = "leads-dashboard-token";
let runtime; let socketPath;

function futureBookable(weekday, minimumDays) {
  const today = localDateKey(new Date(), timezone);
  for (let offset = minimumDays; offset < minimumDays + 60; offset += 1) {
    const candidate = addDateKey(today, offset);
    if (weekdayForDateKey(candidate) !== weekday) continue;
    if (swissHolidaySet(Number(candidate.slice(0, 4)), "ZH").has(candidate)) continue;
    if (["2026-12-24", "2026-12-31"].includes(candidate)) continue;
    return candidate;
  }
  throw new Error("no bookable day");
}
function request(pathname, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: pathname, method, headers }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body);
  });
}
async function post(endpoint, body, expect = 200) {
  const payload = JSON.stringify(body);
  const res = await request(`/webhook/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-retell-webhook-secret": webhookSecret }, body: payload });
  assert.equal(res.status, expect, `${endpoint} HTTP ${res.status}: ${res.text}`);
  return JSON.parse(res.text);
}
async function dashboard(pathname, token = dashboardToken) {
  const res = await request(`/api/dashboard/${pathname}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: res.text ? JSON.parse(res.text) : null };
}
const q = (sql, params) => runtime.db.query(sql, params);

before(async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wa-aios-leads-"));
  socketPath = `/tmp/wa-aios-leads-${process.pid}.sock`;
  runtime = await createRuntime({
    dataDir, socketPath, calendarProvider: "local", databaseUrl: "", noShowSweepIntervalMs: 50,
    env: { ...process.env, RETELL_WEBHOOK_SECRET: webhookSecret, DASHBOARD_API_TOKEN: dashboardToken, RATE_LIMIT_MAX: "500" },
    logger: { log() {}, error() {}, warn() {}, info() {} }
  });
  await runtime.start();
});
after(async () => { if (runtime) await runtime.close(); });

test("lead input normalisation: Swiss national numbers, source validation, channel choice", () => {
  assert.equal(normaliseLeadInput({ phone: "079 555 12 34", source: "website" }).phone, "+41795551234");
  assert.equal(normaliseLeadInput({ phone: "0041 79 555 12 34", source: "website" }).phone, "+41795551234");
  assert.throws(() => normaliseLeadInput({ source: "carrier_pigeon", phone: "+41790000000" }), /source must be one of/);
  assert.throws(() => normaliseLeadInput({ source: "website", name: "Nobody" }), /at least a phone/);
  assert.equal(channelForLead({ source: "instagram", manychatSubscriberId: "1" }), "instagram");
  assert.equal(channelForLead({ source: "website", phone: "+41790000000", email: "a@b.ch" }), "email");
  assert.equal(channelForLead({ source: "website", phone: "+41790000000" }), "whatsapp");
  assert.equal(channelForLead({ source: "google" }), null);
});

test("ManyChat External Request payload becomes an Instagram lead with the subscriber id", () => {
  const lead = leadFromManyChat({ subscriber_id: "987", first_name: "Lara", last_name: "Frei", channel: "instagram", custom_fields: { service: "Balayage", urgency: "now" } });
  assert.equal(lead.source, "instagram");
  assert.equal(lead.manychatSubscriberId, "987");
  assert.equal(lead.name, "Lara Frei");
  assert.equal(lead.serviceInterest, "Balayage");
  assert.equal(lead.urgency, "now");
});

test("an email lead schedules ONE follow-up (not the multi-step ladder), on the right channel", async () => {
  const before = Date.now();
  const out = await post("lead", { source: "website", name: "Nadia Keller", phone: "079 555 12 34", email: "nadia@example.ch", serviceInterest: "Balayage", urgency: "this_week" });
  assert.equal(out.logged, true);
  assert.equal(out.status, "contacted");
  assert.equal(out.channel, "email");
  assert.equal(out.followUpsScheduled, 1, "email leads get a single operational follow-up");

  const msgs = (await q(`select template_id, channel, delivery_status, scheduled_for, subject, body from messages where contact_id = $1::uuid order by scheduled_for`, [out.contactId])).rows;
  assert.deepEqual(msgs.map((m) => m.template_id), ["lead_followup"]);
  assert.ok(msgs.every((m) => m.channel === "email" && m.delivery_status === "queued"));
  assert.ok(msgs[0].subject && msgs[0].subject.length > 0, "subject is persisted at enqueue time");
  const firstDelay = new Date(msgs[0].scheduled_for).getTime() - before;
  assert.ok(firstDelay <= 12 * 3_600_000, "the follow-up is scheduled soon, or deferred only to the end of quiet hours");
  assert.match(msgs[0].body, /Nadia/);
  assert.match(msgs[0].body, /Balayage/);
  const runs = (await q(`select sequence_type, status from sequence_runs where contact_id = $1::uuid`, [out.contactId])).rows;
  assert.equal(runs.filter((r) => r.sequence_type === "lead_follow_up").length, 1);
  console.log(`EVIDENCE lead_followup=${JSON.stringify(msgs.map((m) => ({ t: m.template_id, at: m.scheduled_for })))}`);
});

test("a WhatsApp / Instagram lead still schedules the full multi-step ladder", async () => {
  const out = await post("lead", { source: "whatsapp", name: "Priya Shah", phone: "079 555 77 88", whatsappConsent: true, serviceInterest: "Cut & Finish" });
  assert.equal(out.channel, "whatsapp");
  assert.equal(out.followUpsScheduled, LEAD_LADDER.length);
  const msgs = (await q(`select template_id from messages where contact_id = $1::uuid order by scheduled_for`, [out.contactId])).rows;
  assert.deepEqual(msgs.map((m) => m.template_id), LEAD_LADDER.map((s) => s.templateId));
});

test("booking an appointment exits the lead ladder and marks the lead booked", async () => {
  const phone = "+41795550001";
  const lead = await post("lead", { source: "call", name: "Tom", phone, email: "tom@example.ch", serviceInterest: "Men's Cut" });
  assert.equal(lead.followUpsScheduled, 1);
  const day = futureBookable("wednesday", 10);
  const booking = await post("book-appointment", { startTime: zonedDateTime(day, "11:00", timezone).toISOString(), serviceId: "Men's Cut", staffId: "mara", customerName: "Tom", customerPhone: phone });
  assert.equal(booking.status, "booked");

  const queued = (await q(`select count(*)::int as n from messages where contact_id = $1::uuid and template_id like 'lead_%' and delivery_status = 'queued'`, [lead.contactId])).rows[0].n;
  assert.equal(queued, 0, "no lead follow-ups remain queued after booking");
  const active = (await q(`select count(*)::int as n from sequence_runs where contact_id = $1::uuid and sequence_type in ('lead_follow_up','re_engagement') and status = 'active'`, [lead.contactId])).rows[0].n;
  assert.equal(active, 0);
  const row = (await q(`select status, booked_appointment_id::text as appt from leads where id = $1::uuid`, [lead.leadId])).rows[0];
  assert.equal(row.status, "booked");
  assert.equal(row.appt, booking.appointmentId);
  console.log(`EVIDENCE lead_exit=${JSON.stringify({ queued, active, row })}`);
});

test("a contact who already has an upcoming booking gets no follow-up sequence", async () => {
  const phone = "+41795550002";
  const day = futureBookable("friday", 12);
  await post("book-appointment", { startTime: zonedDateTime(day, "13:00", timezone).toISOString(), serviceId: "Cut & Finish", staffId: "lea", customerName: "Eva", customerPhone: phone });
  const out = await post("lead", { source: "whatsapp", name: "Eva", phone, whatsappConsent: true });
  assert.equal(out.status, "booked");
  assert.equal(out.followUpsScheduled, 0);
});

test("a ManyChat Instagram lead is reachable only via the subscriber id and the dispatcher treats it as consented", async () => {
  const out = await post("manychat-lead", { subscriber_id: "1234567890", first_name: "Lara", last_name: "Frei", channel: "instagram", custom_fields: { service: "Cut & Finish", urgency: "now" } });
  assert.equal(out.channel, "instagram");
  assert.equal(out.followUpsScheduled, LEAD_LADDER.length);
  const contact = (await q(`select manychat_subscriber_id, phone_e164, source from contacts where id = $1::uuid`, [out.contactId])).rows[0];
  assert.equal(contact.manychat_subscriber_id, "1234567890");
  assert.equal(contact.phone_e164, null);
  assert.equal(contact.source, "instagram");
  // Same subscriber again: no duplicate contact, previous ladder superseded by a fresh one.
  const again = await post("manychat-lead", { subscriber_id: "1234567890", first_name: "Lara", channel: "instagram" });
  assert.equal(again.contactId, out.contactId);
  const active = (await q(`select count(*)::int as n from sequence_runs where contact_id = $1::uuid and status = 'active'`, [out.contactId])).rows[0].n;
  assert.equal(active, LEAD_LADDER.length, "exactly one active ladder per contact");
});

test("lead status endpoint validates and 'lost' cancels remaining follow-ups", async () => {
  const lead = await post("lead", { source: "google", name: "Mia", email: "mia@example.ch" });
  await post("lead-status", { leadId: lead.leadId, status: "definitely-maybe" }, 400);
  const out = await post("lead-status", { leadId: lead.leadId, status: "lost", notes: "went elsewhere" });
  assert.equal(out.status, "lost");
  const queued = (await q(`select count(*)::int as n from messages where contact_id = $1::uuid and delivery_status = 'queued'`, [lead.contactId])).rows[0].n;
  assert.equal(queued, 0);
});

test("dashboard API: token required, leads funnel and overview live counts are real", async () => {
  assert.equal((await dashboard("overview", "")).status, 401);
  assert.equal((await dashboard("overview", "wrong")).status, 401);
  const leads = await dashboard("leads");
  assert.equal(leads.status, 200);
  const funnel = Object.fromEntries(leads.json.funnel.map((f) => [f.status, f.count]));
  // The seed ships demo leads too, so assert on what this file created, not on absolute counts.
  assert.ok(funnel.booked >= 2, `booked leads present: ${JSON.stringify(funnel)}`);
  assert.ok(funnel.contacted >= 2);
  assert.ok(funnel.lost >= 1);
  const mine = (await q(`select status from leads where contact_id in (select id from contacts where phone_e164 in ('+41795551234','+41795550001','+41795550002') or email = 'mia@example.ch' or manychat_subscriber_id = '1234567890')`)).rows.map((r) => r.status).sort();
  // Nadia contacted, Tom booked, Eva booked, Lara contacted twice (two enquiries, one ladder), Mia lost.
  assert.deepEqual(mine, ["booked", "booked", "contacted", "contacted", "contacted", "lost"], `statuses of leads created by this file: ${mine}`);
  const overview = await dashboard("overview");
  assert.equal(overview.status, 200);
  assert.ok(overview.json.live.upcoming_appointments >= 2);
  assert.ok(overview.json.live.open_leads >= 2);
  assert.ok(Array.isArray(overview.json.kpis));
  console.log(`EVIDENCE dashboard=${JSON.stringify({ funnel, live: overview.json.live })}`);
});
