// JSON API for the owner dashboard. The API process owns the database; the
// dashboard is a client. Reads: GET, `authorization: Bearer <DASHBOARD_API_TOKEN>`.
// Writes: POST, same token. Tenancy is enforced by row-level security — every
// query runs with app.current_tenant_id set to the resolved tenant.

import { emailAutomationHealth } from "./email-health.mjs";

const clamp = (n, lo, hi, d) => {
  if (n === null || n === undefined || n === "") return d;
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};
const like = (s) => `%${String(s).replace(/[%_]/g, (m) => `\\${m}`)}%`;

export class DashboardApi {
  constructor({ db, services = {} }) {
    this.db = db;
    this.services = services;
  }

  // ---- helpers -------------------------------------------------------------
  async tenantRow(tenantId) {
    return (await this.db.query(`
      select id::text, slug, name, legal_name, locale, fallback_locale, timezone, currency, branding,
             contact_config, avg_appointment_value_chf::float8, baseline_no_show_rate::float8,
             adapter_config, services, quiet_hours, review_config, messaging_config, links, retell_agent_id
      from tenants where id = $1::uuid`, [tenantId])).rows[0];
  }

  // ---- OVERVIEW -----------------------------------------------------------
  async overview(tenantId) {
    const tenant = await this.tenantRow(tenantId);
    const kpis = (await this.db.query(`
      select kpi_date::text, bookings_count, calls_answered, calls_missed, appointments_due, no_shows, no_show_recoveries,
             leads_call, leads_instagram, leads_whatsapp, leads_website, leads_google,
             bookings_call, bookings_instagram, bookings_whatsapp, bookings_website, bookings_google,
             recovered_appointments, recovered_revenue_estimate_chf::float8, reviews_requested, reviews_received,
             rating_sum::float8, rating_count, average_rating::float8
      from kpi_daily where tenant_id = $1::uuid order by kpi_date`, [tenantId])).rows;
    const live = (await this.db.query(`
      select
        (select count(*)::int from appointments where tenant_id = $1::uuid and status = 'booked' and starts_at >= now()) as upcoming_appointments,
        (select count(*)::int from appointments where tenant_id = $1::uuid and status = 'booked' and (starts_at at time zone t.timezone)::date = (now() at time zone t.timezone)::date) as today_appointments,
        (select count(*)::int from leads where tenant_id = $1::uuid and status in ('new','contacted','qualified')) as open_leads,
        (select count(*)::int from complaints where tenant_id = $1::uuid and resolved_at is null) as open_complaints,
        (select count(*)::int from messages where tenant_id = $1::uuid and delivery_status = 'queued') as queued_messages,
        (select count(*)::int from calls where tenant_id = $1::uuid and started_at >= now() - interval '7 days') as calls_7d,
        (select count(*)::int from conversations where tenant_id = $1::uuid and status = 'human_needed') as conversations_need_human,
        (select count(*)::int from contacts where tenant_id = $1::uuid) as total_customers,
        (select count(*)::int from reactivation_campaigns where tenant_id = $1::uuid and status = 'active') as active_reactivation_campaigns,
        (select coalesce(sum(value_chf),0)::float8 from appointments where tenant_id = $1::uuid and status = 'booked' and starts_at >= now()) as upcoming_revenue_chf
      from tenants t where t.id = $1::uuid`, [tenantId])).rows[0];
    const activity = await this.activityRows(tenantId, 12);
    return { tenant, kpis, live, activity, generatedAt: new Date().toISOString() };
  }

  async activityRows(tenantId, limit) {
    return (await this.db.query(`
      select e.event_type, e.aggregate_type, e.occurred_at, e.payload,
             coalesce(c.first_name, '') as first_name, coalesce(c.last_name, '') as last_name
      from events e
      left join contacts c on c.id = e.aggregate_id and c.tenant_id = e.tenant_id
      where e.tenant_id = $1::uuid
      order by e.occurred_at desc limit $2`, [tenantId, limit])).rows;
  }

  async activity(tenantId, url) {
    return { activity: await this.activityRows(tenantId, clamp(url.searchParams.get("limit"), 1, 200, 60)) };
  }

  // ---- APPOINTMENTS ------------------------------------------------------
  async appointments(tenantId, url) {
    const limit = clamp(url.searchParams.get("limit"), 1, 500, 100);
    const scope = url.searchParams.get("scope") === "past" ? "a.starts_at < now()" : "a.starts_at >= now() - interval '1 day'";
    const rows = (await this.db.query(`
      select a.id::text, a.status, a.status_source, a.starts_at, a.ends_at, a.service, a.value_chf::float8, a.staff, a.lead_source,
             a.booked_via, a.recovered_from_no_show_id::text, a.contact_id::text,
             c.first_name, c.last_name, c.phone_e164, c.email
      from appointments a join contacts c on c.id = a.contact_id
      where a.tenant_id = $1::uuid and ${scope}
      order by a.starts_at ${scope.startsWith("a.starts_at <") ? "desc" : "asc"} limit $2`, [tenantId, limit])).rows;
    return { appointments: rows };
  }

  // ---- CALLS ------------------------------------------------------------
  async calls(tenantId, url) {
    const limit = clamp(url.searchParams.get("limit"), 1, 500, 150);
    const rows = (await this.db.query(`
      select k.id::text, k.retell_call_id, k.started_at, k.ended_at, k.duration_seconds, k.answered, k.outcome, k.direction,
             k.disclosure_played, k.transcript, k.recording_url, k.summary, k.sentiment, k.user_sentiment,
             k.from_number, k.to_number, k.call_successful, k.in_voicemail, k.cost_cents,
             k.contact_id::text, k.appointment_id::text, c.first_name, c.last_name, c.phone_e164,
             a.service as appointment_service, a.starts_at as appointment_starts_at, a.status as appointment_status
      from calls k
      left join contacts c on c.id = k.contact_id
      left join appointments a on a.id = k.appointment_id
      where k.tenant_id = $1::uuid order by k.started_at desc limit $2`, [tenantId, limit])).rows;
    const stats = (await this.db.query(`
      select count(*)::int as total,
             count(*) filter (where answered)::int as answered,
             count(*) filter (where outcome = 'booked')::int as booked,
             count(*) filter (where outcome = 'transferred')::int as transferred,
             count(*) filter (where transcript is not null and transcript <> '' and transcript <> '[Demo transcript omitted]')::int as with_transcript,
             coalesce(round(avg(duration_seconds))::int, 0) as avg_duration
      from calls where tenant_id = $1::uuid and started_at >= now() - interval '30 days'`, [tenantId])).rows[0];
    return { calls: rows, stats };
  }

  async call(tenantId, url) {
    const id = url.searchParams.get("id");
    const row = (await this.db.query(`
      select k.*, k.id::text as id, k.contact_id::text as contact_id, k.appointment_id::text as appointment_id,
             k.cost_cents, c.first_name, c.last_name, c.phone_e164, c.email,
             a.service as appointment_service, a.starts_at as appointment_starts_at, a.staff as appointment_staff, a.status as appointment_status
      from calls k
      left join contacts c on c.id = k.contact_id
      left join appointments a on a.id = k.appointment_id
      where k.tenant_id = $1::uuid and k.id = $2::uuid`, [tenantId, id])).rows[0];
    if (!row) return { error: "not_found" };
    delete row.tenant_id;
    return { call: row };
  }

  // ---- LEADS ----------------------------------------------------------
  async leads(tenantId, url) {
    const limit = clamp(url.searchParams.get("limit"), 1, 500, 200);
    const status = url.searchParams.get("status") || null;
    const rows = (await this.db.query(`
      select l.id::text, l.source, l.channel, l.service_interest, l.urgency, l.preferred_time, l.notes, l.status,
             l.booked_appointment_id::text, l.created_at, l.updated_at,
             c.id::text as contact_id, c.first_name, c.last_name, c.phone_e164, c.email, c.manychat_subscriber_id,
             (select count(*)::int from messages m where m.contact_id = c.id and m.template_id like 'lead_%' and m.delivery_status in ('sent','stubbed')) as follow_ups_sent,
             (select min(scheduled_for) from messages m where m.contact_id = c.id and m.template_id like 'lead_%' and m.delivery_status = 'queued') as next_follow_up_at
      from leads l join contacts c on c.id = l.contact_id
      where l.tenant_id = $1::uuid and ($3::text is null or l.status = $3)
      order by l.created_at desc limit $2`, [tenantId, limit, status])).rows;
    const funnel = (await this.db.query(
      `select status, count(*)::int as count from leads where tenant_id = $1::uuid group by status`, [tenantId]
    )).rows;
    return { leads: rows, funnel };
  }

  // ---- CUSTOMERS (CRM) ----------------------------------------------
  async customers(tenantId, url) {
    const limit = clamp(url.searchParams.get("limit"), 1, 500, 100);
    const stage = url.searchParams.get("stage") || null;
    const search = url.searchParams.get("q") || null;
    const rows = (await this.db.query(`
      select c.id::text, c.first_name, c.last_name, c.email, c.phone_e164, c.manychat_subscriber_id,
             c.lifecycle_stage, c.last_interaction_at, c.last_interaction_kind, c.last_booked_at, c.first_booked_at,
             c.total_bookings, c.completed_bookings, c.no_show_count, c.lifetime_value_chf::float8, c.tags,
             c.marketing_opt_out, c.source, c.created_at,
             (select l.status from leads l where l.contact_id = c.id order by l.created_at desc limit 1) as lead_status,
             (select count(*)::int from appointments a where a.contact_id = c.id and a.status = 'booked' and a.starts_at > now()) as upcoming
      from contacts c
      where c.tenant_id = $1::uuid
        and ($3::text is null or c.lifecycle_stage = $3)
        and ($4::text is null or (c.first_name ilike $4 or coalesce(c.last_name,'') ilike $4 or coalesce(c.email,'') ilike $4 or coalesce(c.phone_e164,'') ilike $4))
      order by c.last_interaction_at desc nulls last, c.created_at desc
      limit $2`, [tenantId, limit, stage, search ? like(search) : null])).rows;
    const segments = (await this.db.query(`
      select lifecycle_stage, count(*)::int as count from contacts where tenant_id = $1::uuid group by lifecycle_stage
    `, [tenantId])).rows;
    return { customers: rows, segments };
  }

  async customer(tenantId, url) {
    const id = url.searchParams.get("id");
    const contact = (await this.db.query(`
      select c.*, c.id::text as id, c.lifetime_value_chf::float8 as lifetime_value_chf
      from contacts c where c.tenant_id = $1::uuid and c.id = $2::uuid`, [tenantId, id])).rows[0];
    if (!contact) return { error: "not_found" };
    delete contact.tenant_id;
    const [appointments, calls, messages, notes, leads, sequences, emailActivity] = await Promise.all([
      this.db.query(`
        select id::text, status, status_source, starts_at, ends_at, service, value_chf::float8, staff, lead_source, booked_via
        from appointments where tenant_id = $1::uuid and contact_id = $2::uuid order by starts_at desc limit 50`, [tenantId, id]),
      this.db.query(`
        select id::text, retell_call_id, started_at, ended_at, duration_seconds, outcome, direction, answered,
               summary, recording_url, transcript, sentiment, user_sentiment, disclosure_played,
               from_number, appointment_id::text
        from calls where tenant_id = $1::uuid and contact_id = $2::uuid order by started_at desc limit 30`, [tenantId, id]),
      this.db.query(`
        select id::text, channel, direction, body, template_id, delivery_status, ai_generated, scheduled_for, sent_at, created_at
        from messages where tenant_id = $1::uuid and contact_id = $2::uuid order by coalesce(sent_at, scheduled_for, created_at) desc limit 60`, [tenantId, id]),
      this.db.query(`
        select id::text, author, kind, body, pinned, metadata, created_at
        from contact_notes where tenant_id = $1::uuid and contact_id = $2::uuid order by pinned desc, created_at desc limit 80`, [tenantId, id]),
      this.db.query(`
        select id::text, source, channel, status, service_interest, urgency, created_at, updated_at
        from leads where tenant_id = $1::uuid and contact_id = $2::uuid order by created_at desc`, [tenantId, id]),
      this.db.query(`
        select id::text, sequence_type, status, current_step, next_fire_at, exit_reason, started_at
        from sequence_runs where tenant_id = $1::uuid and contact_id = $2::uuid order by started_at desc limit 30`, [tenantId, id]),
      this.db.query(`
        select id::text, email_type, recipient, subject, status, provider_message_id, error,
               scheduled_for, sent_at, created_at, appointment_id::text, call_id::text, lead_id::text
        from email_events
        where tenant_id = $1::uuid and contact_id = $2::uuid
        order by coalesce(sent_at, scheduled_for, created_at) desc limit 40`, [tenantId, id])
    ]);
    return {
      contact,
      appointments: appointments.rows,
      calls: calls.rows,
      messages: messages.rows,
      notes: notes.rows,
      leads: leads.rows,
      sequences: sequences.rows,
      emailActivity: emailActivity.rows
    };
  }

  // ---- CONVERSATIONS -------------------------------------------------
  async conversations(tenantId, url) {
    const status = url.searchParams.get("status") || null;
    const rows = (await this.db.query(`
      select cv.id::text, cv.channel, cv.status, cv.ai_enabled, cv.last_message_at, cv.last_direction, cv.unread_count,
             cv.contact_id::text, c.first_name, c.last_name, c.phone_e164, c.email,
             (select body from messages m where m.conversation_id = cv.id order by m.created_at desc limit 1) as last_body
      from conversations cv join contacts c on c.id = cv.contact_id
      where cv.tenant_id = $1::uuid and ($2::text is null or cv.status = $2)
      order by cv.last_message_at desc nulls last limit 100`, [tenantId, status])).rows;
    return { conversations: rows };
  }

  async conversation(tenantId, url) {
    const id = url.searchParams.get("id");
    const conversation = (await this.db.query(`
      select cv.id::text, cv.channel, cv.status, cv.ai_enabled, cv.last_message_at, cv.contact_id::text,
             c.first_name, c.last_name, c.phone_e164, c.email, c.lifecycle_stage, c.total_bookings
      from conversations cv join contacts c on c.id = cv.contact_id
      where cv.tenant_id = $1::uuid and cv.id = $2::uuid`, [tenantId, id])).rows[0];
    if (!conversation) return { error: "not_found" };
    const messages = (await this.db.query(`
      select id::text, direction, body, template_id, ai_generated, delivery_status, created_at, sent_at, scheduled_for
      from messages where tenant_id = $1::uuid and conversation_id = $2::uuid order by created_at asc limit 200`, [tenantId, id])).rows;
    await this.db.query("update conversations set unread_count = 0, updated_at = now() where id = $1::uuid", [id]);
    return { conversation, messages };
  }

  // ---- FOLLOW-UPS ---------------------------------------------------
  async followups(tenantId) {
    const active = (await this.db.query(`
      select sr.id::text, sr.sequence_type, sr.current_step, sr.status, sr.next_fire_at, sr.started_at, sr.exit_reason,
             sr.contact_id::text, c.first_name, c.last_name, c.phone_e164, c.email
      from sequence_runs sr join contacts c on c.id = sr.contact_id
      where sr.tenant_id = $1::uuid and sr.status = 'active'
      order by sr.next_fire_at asc nulls last limit 200`, [tenantId])).rows;
    const upcoming = (await this.db.query(`
      select m.id::text, m.channel, m.template_id, m.body, m.scheduled_for, m.contact_id::text,
             c.first_name, c.last_name
      from messages m join contacts c on c.id = m.contact_id
      where m.tenant_id = $1::uuid and m.direction = 'outbound' and m.delivery_status = 'queued'
      order by m.scheduled_for asc limit 100`, [tenantId])).rows;
    const summary = (await this.db.query(`
      select sequence_type,
             count(*) filter (where status = 'active')::int as active,
             count(*) filter (where status = 'completed')::int as completed,
             count(*) filter (where status = 'exited')::int as exited
      from sequence_runs where tenant_id = $1::uuid group by sequence_type`, [tenantId])).rows;
    const outbound30 = (await this.db.query(`
      select delivery_status, count(*)::int as count
      from messages where tenant_id = $1::uuid and direction = 'outbound' and created_at >= now() - interval '30 days'
      group by delivery_status`, [tenantId])).rows;
    return { active, upcoming, summary, outbound30 };
  }

  // ---- REACTIVATION ----------------------------------------------
  async reactivation(tenantId) {
    return this.services.reactivation.listCampaigns(tenantId);
  }
  async reactivationCampaign(tenantId, url) {
    const out = await this.services.reactivation.getCampaign(tenantId, url.searchParams.get("id"));
    return out || { error: "not_found" };
  }

  // ---- ANALYTICS -----------------------------------------------
  async analytics(tenantId, url) {
    const days = clamp(url.searchParams.get("days"), 7, 365, 90);
    const series = (await this.db.query(`
      with span as (
        select generate_series((now() at time zone t.timezone)::date - ($2::int - 1), (now() at time zone t.timezone)::date, interval '1 day')::date as d
        from tenants t where t.id = $1::uuid
      )
      select span.d::text as date,
        (select count(*)::int from appointments a where a.tenant_id = $1::uuid and (a.created_at at time zone 'Europe/Zurich')::date = span.d) as booked,
        (select count(*)::int from appointments a where a.tenant_id = $1::uuid and a.status = 'completed' and (a.ends_at at time zone 'Europe/Zurich')::date = span.d) as completed,
        (select count(*)::int from appointments a where a.tenant_id = $1::uuid and a.status = 'no_show' and (a.starts_at at time zone 'Europe/Zurich')::date = span.d) as no_shows,
        (select count(*)::int from calls k where k.tenant_id = $1::uuid and (k.started_at at time zone 'Europe/Zurich')::date = span.d) as calls,
        (select count(*)::int from leads l where l.tenant_id = $1::uuid and (l.created_at at time zone 'Europe/Zurich')::date = span.d) as leads,
        (select coalesce(sum(a.value_chf),0)::float8 from appointments a where a.tenant_id = $1::uuid and a.status in ('booked','completed') and (a.created_at at time zone 'Europe/Zurich')::date = span.d) as revenue
      from span order by span.d`, [tenantId, days])).rows;
    const bySource = (await this.db.query(`
      select l.source,
             count(*)::int as leads,
             count(*) filter (where l.status = 'booked')::int as booked
      from leads l where l.tenant_id = $1::uuid and l.created_at >= now() - make_interval(days => $2::int)
      group by l.source`, [tenantId, days])).rows;
    const totals = (await this.db.query(`
      select
        (select count(*)::int from appointments where tenant_id = $1::uuid and created_at >= now() - make_interval(days => $2::int)) as bookings,
        (select count(*)::int from appointments where tenant_id = $1::uuid and status = 'completed' and ends_at >= now() - make_interval(days => $2::int)) as completed,
        (select count(*)::int from appointments where tenant_id = $1::uuid and status = 'no_show' and starts_at >= now() - make_interval(days => $2::int)) as no_shows,
        (select coalesce(sum(value_chf),0)::float8 from appointments where tenant_id = $1::uuid and status in ('booked','completed') and created_at >= now() - make_interval(days => $2::int)) as revenue,
        (select count(*)::int from calls where tenant_id = $1::uuid and started_at >= now() - make_interval(days => $2::int)) as calls,
        (select count(*)::int from calls where tenant_id = $1::uuid and answered and started_at >= now() - make_interval(days => $2::int)) as calls_answered,
        (select count(*)::int from calls where tenant_id = $1::uuid and outcome = 'booked' and started_at >= now() - make_interval(days => $2::int)) as calls_booked,
        (select count(*)::int from leads where tenant_id = $1::uuid and created_at >= now() - make_interval(days => $2::int)) as leads,
        (select count(*)::int from leads where tenant_id = $1::uuid and status = 'booked' and created_at >= now() - make_interval(days => $2::int)) as leads_booked,
        (select count(*)::int from messages where tenant_id = $1::uuid and direction = 'outbound' and delivery_status in ('sent','stubbed','delivered') and created_at >= now() - make_interval(days => $2::int)) as messages_sent,
        (select count(*)::int from reactivation_targets where tenant_id = $1::uuid and status = 'booked') as reactivation_bookings,
        (select coalesce(avg(rating),0)::float8 from reviews where tenant_id = $1::uuid and rating is not null) as avg_rating
      `, [tenantId, days])).rows[0];
    return { days, series, bySource, totals };
  }

  // ---- SETTINGS -----------------------------------------------
  async settings(tenantId) {
    const tenant = await this.tenantRow(tenantId);
    const env = this.services?.booking?.env ?? process.env;
    let emailAutomation = { status: "unknown", provider: "resend" };
    try {
      emailAutomation = await emailAutomationHealth(this.db, env, tenantId);
    } catch { /* settings must still load */ }
    return {
      tenant: {
        id: tenant.id, slug: tenant.slug, name: tenant.name, legalName: tenant.legal_name,
        locale: tenant.locale, timezone: tenant.timezone, currency: tenant.currency,
        contact: tenant.contact_config, branding: tenant.branding, links: tenant.links,
        quietHours: tenant.quiet_hours, review: tenant.review_config, messaging: tenant.messaging_config,
        booking: tenant.adapter_config, services: tenant.services, retellAgentId: tenant.retell_agent_id,
        avgAppointmentValueChf: tenant.avg_appointment_value_chf
      },
      emailAutomation
    };
  }

  async tenants() {
    const rows = (await this.db.query(`
      select id::text, slug, name, locale, timezone,
             (select count(*)::int from appointments a where a.tenant_id = t.id and a.starts_at >= now() and a.status = 'booked') as upcoming
      from tenants t order by name`)).rows;
    return { tenants: rows };
  }

  // ======================= WRITES =======================
  async createNote(tenantId, body) {
    if (!body.contactId || !body.body) return { error: "invalid_request", message: "contactId and body are required." };
    const row = (await this.db.query(`
      insert into contact_notes (tenant_id, contact_id, author, kind, body, pinned)
      values ($1::uuid, $2::uuid, 'staff', $3, $4, $5)
      returning id::text, created_at
    `, [tenantId, body.contactId, body.kind || "note", String(body.body).slice(0, 4000), Boolean(body.pinned)])).rows[0];
    return { created: true, note: row };
  }

  async updateCustomer(tenantId, body) {
    if (!body.contactId) return { error: "invalid_request" };
    const sets = [];
    const params = [tenantId, body.contactId];
    if (body.lifecycleStage && ["lead", "active", "inactive", "vip"].includes(body.lifecycleStage)) {
      params.push(body.lifecycleStage); sets.push(`lifecycle_stage = $${params.length}`);
    }
    if (typeof body.marketingOptOut === "boolean") { params.push(body.marketingOptOut); sets.push(`marketing_opt_out = $${params.length}`); }
    if (Array.isArray(body.tags)) { params.push(body.tags); sets.push(`tags = $${params.length}::text[]`); }
    if (body.email !== undefined) { params.push(body.email || null); sets.push(`email = $${params.length}`); }
    if (!sets.length) return { updated: false };
    const row = (await this.db.query(
      `update contacts set ${sets.join(", ")}, updated_at = now() where tenant_id = $1::uuid and id = $2::uuid returning id::text`,
      params
    )).rows[0];
    return { updated: Boolean(row) };
  }

  async replyToConversation(tenantId, body) {
    const conversation = (await this.db.query(
      "select cv.*, c.first_name from conversations cv join contacts c on c.id = cv.contact_id where cv.tenant_id = $1::uuid and cv.id = $2::uuid",
      [tenantId, body.conversationId]
    )).rows[0];
    if (!conversation) return { error: "not_found" };
    if (!body.body) return { error: "invalid_request" };
    await this.db.query(`
      insert into messages (tenant_id, contact_id, conversation_id, channel, direction, body, delivery_status, scheduled_for, ai_generated)
      values ($1::uuid, $2::uuid, $3::uuid, $4, 'outbound', $5, 'queued', now(), false)
    `, [tenantId, conversation.contact_id, conversation.id, conversation.channel, String(body.body).slice(0, 4000)]);
    await this.db.query(`
      update conversations set status = case when $2::boolean then 'ai_handling' else 'open' end,
        last_message_at = now(), last_direction = 'outbound', updated_at = now()
      where id = $1::uuid`, [conversation.id, conversation.ai_enabled]);
    return { sent: true };
  }

  async updateConversation(tenantId, body) {
    const sets = [];
    const params = [tenantId, body.conversationId];
    if (body.status && ["open", "ai_handling", "human_needed", "closed"].includes(body.status)) {
      params.push(body.status); sets.push(`status = $${params.length}`);
    }
    if (typeof body.aiEnabled === "boolean") { params.push(body.aiEnabled); sets.push(`ai_enabled = $${params.length}`); }
    if (!sets.length) return { updated: false };
    const row = (await this.db.query(
      `update conversations set ${sets.join(", ")}, updated_at = now() where tenant_id = $1::uuid and id = $2::uuid returning id::text`,
      params
    )).rows[0];
    return { updated: Boolean(row) };
  }

  async updateSettings(tenantId, body) {
    const allowed = {
      contact_config: body.contact, branding: body.branding, links: body.links,
      quiet_hours: body.quietHours, review_config: body.review, messaging_config: body.messaging,
      adapter_config: body.booking, services: body.services
    };
    const sets = [];
    const params = [tenantId];
    for (const [column, value] of Object.entries(allowed)) {
      if (value === undefined) continue;
      params.push(JSON.stringify(value));
      sets.push(`${column} = $${params.length}::jsonb`);
    }
    if (body.name) { params.push(String(body.name).slice(0, 120)); sets.push(`name = $${params.length}`); }
    if (body.avgAppointmentValueChf != null) { params.push(Number(body.avgAppointmentValueChf)); sets.push(`avg_appointment_value_chf = $${params.length}::numeric`); }
    // Targeted merge into messaging_config.email so per-email-type toggles don't
    // clobber senderName / templates / mode / other messaging config.
    if (body.emailAutomation && typeof body.emailAutomation === "object" && body.messaging === undefined) {
      const clean = {};
      const boolKeys = ["confirmation", "reminder24h", "reminder2h", "reminder48h", "rescheduled", "cancelled", "missedCall", "leadFollowup", "completion"];
      for (const k of boolKeys) if (typeof body.emailAutomation[k] === "boolean") clean[k] = body.emailAutomation[k];
      if (body.emailAutomation.leadFollowupDelayMinutes != null) {
        clean.leadFollowupDelayMinutes = clamp(body.emailAutomation.leadFollowupDelayMinutes, 1, 10080, 30);
      }
      if (typeof body.emailAutomation.from === "string") clean.from = body.emailAutomation.from.slice(0, 200);
      if (typeof body.emailAutomation.replyTo === "string") clean.replyTo = body.emailAutomation.replyTo.slice(0, 200);
      if (typeof body.emailAutomation.senderName === "string") clean.senderName = body.emailAutomation.senderName.slice(0, 120);
      params.push(JSON.stringify(clean));
      sets.push(`messaging_config = jsonb_set(coalesce(messaging_config, '{}'::jsonb), '{email}', coalesce(messaging_config->'email', '{}'::jsonb) || $${params.length}::jsonb, true)`);
    }
    if (!sets.length) return { updated: false };
    await this.db.query(
      `update tenants set ${sets.join(", ")}, updated_at = now() where id = $1::uuid`, params
    );
    return { updated: true };
  }
}

export const DASHBOARD_ROUTES = new Map([
  ["/api/dashboard/overview", "overview"],
  ["/api/dashboard/activity", "activity"],
  ["/api/dashboard/appointments", "appointments"],
  ["/api/dashboard/calls", "calls"],
  ["/api/dashboard/call", "call"],
  ["/api/dashboard/leads", "leads"],
  ["/api/dashboard/customers", "customers"],
  ["/api/dashboard/customer", "customer"],
  ["/api/dashboard/conversations", "conversations"],
  ["/api/dashboard/conversation", "conversation"],
  ["/api/dashboard/followups", "followups"],
  ["/api/dashboard/reactivation", "reactivation"],
  ["/api/dashboard/reactivation-campaign", "reactivationCampaign"],
  ["/api/dashboard/analytics", "analytics"],
  ["/api/dashboard/settings", "settings"],
  ["/api/dashboard/tenants", "tenants"]
]);

// POST routes: [handlerTarget, method]. "self" = DashboardApi; others resolve
// against the services map in server.mjs.
export const DASHBOARD_WRITE_ROUTES = new Map([
  ["/api/dashboard/notes", ["self", "createNote"]],
  ["/api/dashboard/customer-update", ["self", "updateCustomer"]],
  ["/api/dashboard/conversation-reply", ["self", "replyToConversation"]],
  ["/api/dashboard/conversation-update", ["self", "updateConversation"]],
  ["/api/dashboard/settings-update", ["self", "updateSettings"]],
  ["/api/dashboard/lead-status", ["leads", "updateLeadStatus"]],
  ["/api/dashboard/appointment-outcome", ["booking", "markAppointmentOutcome"]],
  ["/api/dashboard/reactivation-preview", ["reactivation", "preview"]],
  ["/api/dashboard/reactivation-create", ["reactivation", "createCampaign"]],
  ["/api/dashboard/reactivation-launch", ["reactivation", "launchCampaign"]],
  ["/api/dashboard/reactivation-status", ["reactivation", "setStatus"]]
]);
