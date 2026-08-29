import { randomUUID } from "node:crypto";
import {
  formatSpoken,
  isQuietTime,
  localDateKey,
  minutesOfDay,
  nextQuietEnd,
  normaliseSlug,
  swissHolidaySet,
  zonedParts
} from "./time.mjs";
import { DEFAULT_TENANT_ID, jsonValue } from "./database.mjs";
import { renderMessageTemplate } from "./messaging-templates.mjs";
import { markLeadBooked } from "./leads.mjs";

const isoWithZone = /(?:Z|[+-]\d{2}:\d{2})$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(value) {
  return new Date(value).toISOString();
}

function normalisePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function firstName(value) {
  return String(value || "Caller").trim().split(/\s+/)[0] || "Caller";
}

function parseDate(value) {
  if (typeof value !== "string" || !isoWithZone.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toTenant(row) {
  return {
    ...row,
    adapter_config: jsonValue(row.adapter_config, {}),
    services: jsonValue(row.services, []),
    quiet_hours: jsonValue(row.quiet_hours, { start: "21:00", end: "08:00" }),
    review_config: jsonValue(row.review_config, {}),
    messaging_config: jsonValue(row.messaging_config, { mode: "stub" }),
    contact_config: jsonValue(row.contact_config, {}),
    links: jsonValue(row.links, {}),
    branding: jsonValue(row.branding, {})
  };
}

function resolveService(tenant, requested) {
  const key = normaliseSlug(requested);
  if (!key) return undefined;
  const services = tenant.services ?? [];
  const exact = services.find((service) =>
    normaliseSlug(service.id || service.name) === key || normaliseSlug(service.name) === key
  );
  if (exact) return exact;
  // Voice fallback: a caller / LLM often says "a men's cut" or "cut and finish please"
  // rather than the exact menu label. Match on containment, longest service first
  // so "cut" alone still resolves deterministically.
  if (key.length < 3) return undefined;
  return [...services]
    .sort((a, b) => normaliseSlug(b.name).length - normaliseSlug(a.name).length)
    .find((service) => {
      const slug = normaliseSlug(service.name);
      return slug && (slug.includes(key) || key.includes(slug));
    });
}

// A tenant with adapter_config.sharedCalendarId runs one shared calendar for the
// whole salon: the caller is never asked to choose a stylist and every calendar
// operation targets that one calendar. The staff[] entries stay in config as
// internal labels but are not surfaced.
function sharedCalendarId(tenant) {
  const id = tenant.adapter_config?.sharedCalendarId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function salonAsStaff(tenant) {
  return { id: "salon", name: tenant.name, calendarId: sharedCalendarId(tenant) };
}

// Candidate list for availability searches. One synthetic salon entry when a
// shared calendar is configured, otherwise the configured stylists.
function bookingCandidates(tenant) {
  return sharedCalendarId(tenant) ? [salonAsStaff(tenant)] : (tenant.adapter_config.staff ?? []);
}

function resolveStaff(tenant, requested, defaultFirst = true) {
  if (sharedCalendarId(tenant)) return salonAsStaff(tenant);
  const staff = tenant.adapter_config.staff ?? [];
  if (!requested) return defaultFirst ? staff[0] : null;
  const key = normaliseSlug(requested);
  return staff.find((member) =>
    normaliseSlug(member.id) === key ||
    normaliseSlug(member.name) === key ||
    (member.aliases ?? []).some((alias) => normaliseSlug(alias) === key)
  );
}

function openingValidation(tenant, start, end) {
  const timezone = tenant.timezone;
  const booking = tenant.adapter_config;
  const startParts = zonedParts(start, timezone);
  const endParts = zonedParts(end, timezone);
  const startDate = localDateKey(start, timezone);
  const endDate = localDateKey(end, timezone);
  const windows = booking.hours?.[startParts.weekday.toLowerCase()] ?? [];
  const startMinute = Number(startParts.hour) * 60 + Number(startParts.minute);
  const endMinute = Number(endParts.hour) * 60 + Number(endParts.minute);
  const withinHours = startDate === endDate && windows.some((window) => {
    const [openHour, openMinute] = window.start.split(":").map(Number);
    const [closeHour, closeMinute] = window.end.split(":").map(Number);
    return startMinute >= openHour * 60 + openMinute && endMinute <= closeHour * 60 + closeMinute;
  });
  const explicitlyClosed = [
    ...(booking.closureDates ?? []),
    ...(booking.additionalHolidayDates ?? [])
  ].includes(startDate);
  const holiday = swissHolidaySet(Number(startParts.year), booking.swissHolidayRegion).has(startDate);
  const slotInterval = Number(booking.slotIntervalMinutes ?? 30);
  const aligned = startMinute % slotInterval === 0 && Number(startParts.second) === 0;

  if (!aligned) {
    return {
      ok: false,
      code: "invalid_request",
      message: `Appointments start every ${slotInterval} minutes. Please choose one of those times.`
    };
  }
  if (!withinHours || explicitlyClosed || holiday) {
    return {
      ok: false,
      code: "closed",
      message: "That time is outside opening hours or falls on a closure or Swiss public holiday."
    };
  }
  return { ok: true };
}

async function upsertContact(client, tenantId, details) {
  const phone = normalisePhone(details.phone);
  if (!phone) {
    const inserted = await client.query(`
      insert into contacts (tenant_id, first_name, email, source, whatsapp_consent, email_consent)
      values ($1::uuid, $2, nullif($3, ''), 'call', false, (nullif($3, '') is not null))
      returning id::text
    `, [tenantId, firstName(details.name), String(details.email ?? "")]);
    return inserted.rows[0].id;
  }

  const result = await client.query(`
    insert into contacts (
      tenant_id, first_name, phone_e164, email, source, whatsapp_consent, email_consent
    ) values ($1::uuid, $2, $3, nullif($4, ''), 'call', $5, (nullif($4, '') is not null))
    on conflict (tenant_id, phone_e164) do update set
      first_name = excluded.first_name,
      email = coalesce(excluded.email, contacts.email),
      whatsapp_consent = contacts.whatsapp_consent or excluded.whatsapp_consent,
      email_consent = contacts.email_consent or excluded.email_consent,
      updated_at = now()
    returning id::text
  `, [
    tenantId,
    firstName(details.name),
    phone,
    String(details.email ?? ""),
    Boolean(details.whatsappConsent)
  ]);
  return result.rows[0].id;
}

async function queueMessage(client, {
  tenant,
  contactId = null,
  appointmentId = null,
  channel,
  templateId,
  scheduledFor,
  contact = {},
  appointment = {},
  complaint = {},
  bodyPrefix = ""
}) {
  const rendered = renderMessageTemplate({ tenant, templateId, contact, appointment, complaint });
  await client.query(`
    insert into messages (
      tenant_id, contact_id, appointment_id, channel, direction, body,
      template_id, delivery_status, scheduled_for
    ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'outbound', $5, $6, 'queued', $7::timestamptz)
  `, [
    tenant.id,
    contactId,
    appointmentId,
    channel,
    `${bodyPrefix}${rendered.body}`,
    templateId,
    new Date(scheduledFor).toISOString()
  ]);
  return rendered;
}

// Immediate booking confirmation. Email when we have one (it carries the most
// detail), WhatsApp otherwise. Queued for "now" so the dispatcher sends it on
// its next cycle — subject to the same consent and quiet-hours rules.
async function scheduleConfirmation(client, tenant, appointment, { channel } = {}) {
  const useChannel = channel || (appointment.contact_email ? "email" : "whatsapp");
  await queueMessage(client, {
    tenant,
    contactId: appointment.contact_id,
    appointmentId: appointment.id,
    channel: useChannel,
    templateId: "appointment_confirmation",
    scheduledFor: new Date(),
    contact: { first_name: appointment.contact_first_name },
    appointment
  });
  await client.query(`
    insert into sequence_runs (tenant_id, contact_id, appointment_id, sequence_type, status, current_step, next_fire_at, metadata)
    values ($1::uuid, $2::uuid, $3::uuid, 'appointment_confirmation', 'completed', 'appointment_confirmation', null, $4::jsonb)
  `, [tenant.id, appointment.contact_id, appointment.id, JSON.stringify({ channel: useChannel })]);
}

// Post-visit thank-you, queued for the appointment end time. The completion
// sweep also schedules the review request separately.
async function scheduleCompletionMessage(client, tenant, appointment) {
  const useChannel = appointment.contact_email ? "email" : "whatsapp";
  await queueMessage(client, {
    tenant,
    contactId: appointment.contact_id,
    appointmentId: appointment.id,
    channel: useChannel,
    templateId: "appointment_completion",
    scheduledFor: new Date(new Date(appointment.ends_at).getTime() + 30 * 60_000),
    contact: { first_name: appointment.contact_first_name },
    appointment
  });
  await client.query(`
    insert into sequence_runs (tenant_id, contact_id, appointment_id, sequence_type, status, current_step, next_fire_at, metadata)
    values ($1::uuid, $2::uuid, $3::uuid, 'appointment_completion', 'completed', 'appointment_completion', null, $4::jsonb)
  `, [tenant.id, appointment.contact_id, appointment.id, JSON.stringify({ channel: useChannel })]);
}

async function scheduleReminders(client, tenant, appointment) {
  const plans = [
    { templateId: "appointment_t_48h", channel: "whatsapp", hours: 48 },
    { templateId: "appointment_t_24h", channel: "email", hours: 24 },
    { templateId: "appointment_t_2h", channel: "whatsapp", hours: 2 }
  ];

  for (const plan of plans) {
    const dueAt = new Date(new Date(appointment.starts_at).getTime() - plan.hours * 3_600_000);
    const quiet = isQuietTime(dueAt, tenant.timezone, tenant.quiet_hours);
    const dropped = quiet && plan.templateId === "appointment_t_2h";
    if (dropped) {
      const rendered = renderMessageTemplate({
        tenant,
        templateId: plan.templateId,
        contact: { first_name: appointment.contact_first_name },
        appointment
      });
      await client.query(`
        insert into messages (
          tenant_id, contact_id, appointment_id, channel, direction, body,
          template_id, delivery_status, scheduled_for
        ) values ($1::uuid, $2::uuid, $3::uuid, $4, 'outbound', $5, $6, 'dropped_quiet_hours', $7::timestamptz)
      `, [tenant.id, appointment.contact_id, appointment.id, plan.channel, rendered.body, plan.templateId, dueAt.toISOString()]);
    } else {
      await queueMessage(client, {
        tenant,
        contactId: appointment.contact_id,
        appointmentId: appointment.id,
        channel: plan.channel,
        templateId: plan.templateId,
        scheduledFor: dueAt,
        contact: { first_name: appointment.contact_first_name },
        appointment
      });
    }

    if (!dropped) {
      const fireAt = quiet ? nextQuietEnd(dueAt, tenant.timezone, tenant.quiet_hours) : dueAt;
      await client.query(`
        insert into sequence_runs (
          tenant_id, contact_id, appointment_id, sequence_type, status,
          current_step, next_fire_at, metadata
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 'appointment_reminder', 'active',
          $4, $5::timestamptz, $6::jsonb
        )
      `, [
        tenant.id,
        appointment.contact_id,
        appointment.id,
        plan.templateId,
        fireAt.toISOString(),
        JSON.stringify({
          channel: plan.channel,
          originalDueAt: dueAt.toISOString(),
          quietHoursDeferred: quiet
        })
      ]);
    }
  }
}

async function scheduleNoShowRecovery(client, tenant, appointment) {
  const plans = [
    { templateId: "no_show_t_30m", delayHours: 0.5 },
    { templateId: "no_show_day_1", delayHours: 24 },
    { templateId: "no_show_day_3", delayHours: 72 },
    { templateId: "no_show_day_7", delayHours: 168 }
  ];
  for (const plan of plans) {
    const scheduledFor = new Date(new Date(appointment.starts_at).getTime() + plan.delayHours * 3_600_000);
    await queueMessage(client, {
      tenant,
      contactId: appointment.contact_id,
      appointmentId: appointment.id,
      channel: "whatsapp",
      templateId: plan.templateId,
      scheduledFor,
      contact: { first_name: appointment.contact_first_name },
      appointment
    });
    await client.query(`
      insert into sequence_runs (
        tenant_id, contact_id, appointment_id, sequence_type, status,
        current_step, next_fire_at, metadata
      ) values ($1::uuid, $2::uuid, $3::uuid, 'no_show_recovery', 'active', $4, $5::timestamptz, $6::jsonb)
    `, [
      tenant.id,
      appointment.contact_id,
      appointment.id,
      plan.templateId,
      scheduledFor.toISOString(),
      JSON.stringify({ channel: "whatsapp", originalDueAt: scheduledFor.toISOString() })
    ]);
  }
}

async function scheduleReviewRequest(client, tenant, appointment) {
  const review = tenant.review_config;
  const delayHours = Number(review.delayHours ?? 2);
  const scheduledFor = new Date(new Date(appointment.ends_at).getTime() + delayHours * 3_600_000);
  const templateId = review.gateEnabled === false ? "review_request" : "review_rating_gate";
  const reviewRecord = await client.query(`
    insert into reviews (tenant_id, contact_id, appointment_id, requested_at)
    values ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)
    on conflict (tenant_id, appointment_id) do nothing
    returning id::text
  `, [tenant.id, appointment.contact_id, appointment.id, scheduledFor.toISOString()]);
  if (!reviewRecord.rows.length) return false;
  await queueMessage(client, {
    tenant,
    contactId: appointment.contact_id,
    appointmentId: appointment.id,
    channel: review.channel || "email",
    templateId,
    scheduledFor,
    contact: { first_name: appointment.contact_first_name },
    appointment
  });
  await client.query(`
    insert into sequence_runs (
      tenant_id, contact_id, appointment_id, sequence_type, status,
      current_step, next_fire_at, metadata
    ) values ($1::uuid, $2::uuid, $3::uuid, 'review_request', 'active', $4, $5::timestamptz, $6::jsonb)
  `, [
    tenant.id,
    appointment.contact_id,
    appointment.id,
    templateId,
    scheduledFor.toISOString(),
    JSON.stringify({ channel: review.channel || "email", ratingGateEnabled: review.gateEnabled !== false })
  ]);
  return true;
}

async function invalidateReminders(client, appointmentId, reason) {
  await client.query(`
    update messages
    set delivery_status = 'failed'
    where appointment_id = $1::uuid
      and template_id in ('appointment_t_48h', 'appointment_t_24h', 'appointment_t_2h', 'appointment_completion')
      and delivery_status = 'queued'
  `, [appointmentId]);
  await client.query(`
    update sequence_runs
    set status = 'exited', exit_reason = $2, next_fire_at = null
    where appointment_id = $1::uuid
      and sequence_type in ('appointment_reminder', 'appointment_completion')
      and status = 'active'
  `, [appointmentId, reason]);
}

export class BookingService {
  constructor({ db, calendar, env = process.env, logger = console }) {
    this.db = db;
    this.calendar = calendar;
    this.env = env;
    this.logger = logger;
  }

  async tenant(tenantId = DEFAULT_TENANT_ID, client = this.db) {
    const result = await client.query(`
      select id::text, slug, name, locale, fallback_locale, timezone, currency, avg_appointment_value_chf,
             adapter_config, services, quiet_hours, review_config, messaging_config,
             contact_config, links, branding
      from tenants where id = $1::uuid
    `, [tenantId]);
    if (!result.rows.length) throw new Error(`Tenant ${tenantId} was not found.`);
    return toTenant(result.rows[0]);
  }

  validateRequest(tenant, body, { booking = false } = {}) {
    if (booking && (!body.customerName || !body.customerPhone)) {
      return { error: { code: "invalid_request", message: "Please provide startTime, serviceId, customerName and customerPhone." } };
    }
    const service = resolveService(tenant, body.serviceId);
    if (!service) {
      return { error: { code: "unknown_service", message: "I could not match that service to the salon menu." } };
    }
    const staff = resolveStaff(tenant, body.staffId, booking);
    if (body.staffId && !staff) {
      return { error: { code: "unknown_staff", message: "I could not match that stylist to the salon team." } };
    }
    const start = parseDate(body.startTime);
    const durationMinutes = Number(service.durationMinutes ?? tenant.adapter_config.defaultDurationMinutes);
    if (!start || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return { error: { code: "invalid_request", message: "Please provide a valid ISO8601 startTime with its Swiss UTC offset." } };
    }
    if (start.getTime() <= Date.now()) {
      return { error: { code: "invalid_request", message: "That time is in the past. Please choose a future appointment." } };
    }
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    const opening = openingValidation(tenant, start, end);
    return { service, staff, start, end, durationMinutes, opening };
  }

  async alternatives(tenant, requestedStart, service, requestedStaff, limit = 3) {
    const interval = Number(tenant.adapter_config.slotIntervalMinutes ?? 30);
    const rangeDays = Number(tenant.adapter_config.searchRangeDays ?? 10);
    const candidates = requestedStaff ? [requestedStaff] : bookingCandidates(tenant);
    const results = [];
    const seen = new Set();

    for (let step = 1; step <= Math.ceil(rangeDays * 24 * 60 / interval); step += 1) {
      const start = new Date(requestedStart.getTime() + step * interval * 60_000);
      const end = new Date(start.getTime() + Number(service.durationMinutes ?? tenant.adapter_config.defaultDurationMinutes) * 60_000);
      if (!openingValidation(tenant, start, end).ok) continue;
      for (const staff of candidates) {
        const key = `${staff.id}:${start.toISOString()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const available = await this.calendar.isAvailable({
          tenantId: tenant.id,
          calendarId: staff.calendarId,
          startTime: start.toISOString(),
          endTime: end.toISOString()
        });
        if (!available) continue;
        results.push({
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          staffId: staff.id,
          staffName: staff.name,
          spokenTime: formatSpoken(start, tenant.timezone)
        });
        if (results.length === limit) return results;
      }
    }
    return results;
  }

  async checkAvailability(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const validated = this.validateRequest(tenant, body);
    if (validated.error) {
      return { available: false, ...validated.error, alternatives: [], serviceId: body.serviceId ?? null };
    }
    const { service, start, end, opening } = validated;
    const staffCandidates = body.staffId
      ? [validated.staff]
      : bookingCandidates(tenant);

    if (opening.ok) {
      for (const staff of staffCandidates) {
        const available = await this.calendar.isAvailable({
          tenantId: tenant.id,
          calendarId: staff.calendarId,
          startTime: start.toISOString(),
          endTime: end.toISOString()
        });
        if (available) {
          const spoken = formatSpoken(start, tenant.timezone);
          return {
            available: true,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            staffId: staff.id,
            staffName: staff.name,
            serviceId: normaliseSlug(service.id || service.name),
            service: service.name,
            message: `Yes, ${staff.name} is available on ${spoken} for ${service.name}.`
          };
        }
      }
    }

    const alternatives = await this.alternatives(tenant, start, service, validated.staff);
    const suffix = alternatives.length
      ? ` The closest options are ${alternatives.map((slot) => `${slot.spokenTime} with ${slot.staffName}`).join(", ")}.`
      : " I could not find another opening in the configured search range.";
    return {
      available: false,
      code: opening.ok ? "slot_taken" : opening.code,
      serviceId: normaliseSlug(service.id || service.name),
      service: service.name,
      alternatives,
      message: `${opening.ok ? "That time is not available." : opening.message}${suffix}`
    };
  }

  async acquireSlot(client, tenant, staff, start, end) {
    const requestId = `${staff.id}:${start.toISOString()}:${end.toISOString()}:${randomUUID()}`;
    const result = await client.query(`
      select locked, lock_id::text
      from try_acquire_booking_slot($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5)
    `, [tenant.id, staff.calendarId, start.toISOString(), end.toISOString(), requestId]);
    return result.rows[0];
  }

  async slotTakenResponse(tenant, start, service, staff) {
    const alternatives = await this.alternatives(tenant, start, service, staff);
    return {
      status: "not_booked",
      code: "slot_taken",
      alternativeSlots: alternatives.map(({ startTime, endTime }) => ({ startTime, endTime })),
      message: alternatives.length
        ? `That time has just been taken. I can offer ${alternatives.map((slot) => slot.spokenTime).join(", ")}.`
        : "That time has just been taken, and I could not find another opening in the configured search range."
    };
  }

  async bookAppointment(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const validated = this.validateRequest(tenant, body, { booking: true });
    if (validated.error || !validated.opening?.ok) {
      const failure = validated.error ?? validated.opening;
      return { status: "not_booked", code: failure.code, message: failure.message };
    }
    const { service, staff, start, end } = validated;
    let createdEvent = null;

    try {
      const result = await this.db.transaction(async (tx) => {
        const lock = await this.acquireSlot(tx, tenant, staff, start, end);
        if (!lock.locked) return { slotTaken: true };

        const free = await this.calendar.isAvailable({
          tenantId: tenant.id,
          calendarId: staff.calendarId,
          startTime: start.toISOString(),
          endTime: end.toISOString()
        }, { db: tx });
        if (!free) {
          await tx.query("delete from booking_slot_locks where id = $1::uuid", [lock.lock_id]);
          return { slotTaken: true };
        }

        createdEvent = await this.calendar.createEvent({
          tenantId: tenant.id,
          calendarId: staff.calendarId,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          summary: `${body.customerName} - ${service.name}`,
          description: `Phone: ${normalisePhone(body.customerPhone)}\nTenant: ${tenant.id}${body.notes ? `\nNotes: ${body.notes}` : ""}`
        }, { db: tx });

        const contactId = await upsertContact(tx, tenant.id, {
          name: body.customerName,
          phone: body.customerPhone,
          email: body.customerEmail,
          whatsappConsent: true
        });
        const appointmentResult = await tx.query(`
          insert into appointments (
            tenant_id, contact_id, external_id, platform, status, status_source,
            starts_at, ends_at, service, value_chf, staff, staff_calendar_id, lead_source
          ) values (
            $1::uuid, $2::uuid, $3, $4, 'booked', 'workflow',
            $5::timestamptz, $6::timestamptz, $7, $8::numeric, $9, $10, 'call'
          ) returning *, id::text as id, contact_id::text as contact_id
        `, [
          tenant.id,
          contactId,
          createdEvent.id,
          this.calendar.provider === "google" ? "google_calendar" : "local",
          start.toISOString(),
          end.toISOString(),
          service.name,
          Number(service.priceChf ?? tenant.avg_appointment_value_chf),
          staff.name,
          staff.calendarId
        ]);
        const appointment = appointmentResult.rows[0];
        await tx.query(`
          insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
          values ($1::uuid, 'appointment', $2::uuid, 'appointment.created', 'api.booking', $3::jsonb)
        `, [tenant.id, appointment.id, JSON.stringify({ externalId: createdEvent.id, staff: staff.name })]);
        const apptForMessaging = {
          ...appointment,
          contact_first_name: firstName(body.customerName),
          contact_email: body.customerEmail || null
        };
        await scheduleConfirmation(tx, tenant, apptForMessaging);
        await scheduleReminders(tx, tenant, apptForMessaging);
        await scheduleCompletionMessage(tx, tenant, apptForMessaging);
        await markLeadBooked(tx, tenant.id, appointment.contact_id, appointment.id);
        await tx.query(`
          update contacts set
            lifecycle_stage = case when lifecycle_stage = 'lead' then 'active' else lifecycle_stage end,
            last_interaction_at = now(), last_interaction_kind = 'appointment',
            first_booked_at = coalesce(first_booked_at, $2::timestamptz),
            last_booked_at = greatest(coalesce(last_booked_at, '-infinity'::timestamptz), $2::timestamptz),
            total_bookings = total_bookings + 1,
            updated_at = now()
          where id = $1::uuid
        `, [appointment.contact_id, appointment.starts_at]);
        await tx.query(`
          insert into contact_notes (tenant_id, contact_id, author, kind, body, metadata)
          values ($1::uuid, $2::uuid, 'system', 'appointment', $3, $4::jsonb)
        `, [tenant.id, appointment.contact_id,
            `Booked ${service.name} with ${staff.name}`,
            JSON.stringify({ appointmentId: appointment.id, startsAt: appointment.starts_at, via: body.bookedVia || "call" })]);
        await tx.query("delete from booking_slot_locks where id = $1::uuid", [lock.lock_id]);
        return { appointment };
      });

      if (result.slotTaken) return this.slotTakenResponse(tenant, start, service, staff);
      return {
        status: "booked",
        appointmentId: result.appointment.id,
        startTime: iso(result.appointment.starts_at),
        endTime: iso(result.appointment.ends_at),
        staff: result.appointment.staff,
        message: "Appointment successfully booked."
      };
    } catch (error) {
      if (createdEvent && this.calendar.provider === "google") {
        try {
          await this.calendar.deleteEvent({ tenantId: tenant.id, calendarId: staff.calendarId, eventId: createdEvent.id });
        } catch (cleanupError) {
          this.logger.error("Google Calendar compensation failed", cleanupError);
        }
      }
      if (error?.code === "23P01" || /exclusion constraint/i.test(error?.message ?? "")) {
        return this.slotTakenResponse(tenant, start, service, staff);
      }
      this.logger.error("Booking failed", error);
      return {
        status: "not_booked",
        code: this.calendar.provider === "google" ? "calendar_error" : "persistence_failed",
        message: "I could not safely save that appointment. Nothing was booked; please let the salon team help."
      };
    }
  }

  async findAppointment(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const digits = String(body.customerPhone ?? "").replace(/\D/g, "");
    if (!digits) return { found: false, appointments: [], message: "Please provide the phone number used for the booking." };
    const result = await this.db.query(`
      select a.id::text, a.starts_at, a.ends_at, a.service, a.staff
      from appointments a
      join contacts c on c.id = a.contact_id
      where a.tenant_id = $1::uuid
        and regexp_replace(coalesce(c.phone_e164, ''), '[^0-9]', '', 'g') = $2
        and a.status = 'booked'
        and a.starts_at > now()
      order by a.starts_at
    `, [tenant.id, digits]);
    const appointments = result.rows.map((row) => ({
      appointmentId: row.id,
      startTime: iso(row.starts_at),
      endTime: iso(row.ends_at),
      service: row.service,
      staff: row.staff,
      spokenSummary: `${row.service} with ${row.staff} on ${formatSpoken(row.starts_at, tenant.timezone)}`
    }));
    return appointments.length
      ? { found: true, appointments, message: `I found ${appointments[0].spokenSummary}.` }
      : { found: false, appointments: [], message: "I could not find a future booked appointment for that phone number." };
  }

  async rescheduleAppointment(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    if (!uuidPattern.test(String(body.appointmentId ?? ""))) {
      return { status: "not_found", message: "I could not find that future booked appointment." };
    }
    const existingResult = await this.db.query(`
      select a.*, a.id::text as id, a.contact_id::text as contact_id, c.first_name as contact_first_name
      from appointments a
      join contacts c on c.id = a.contact_id
      where a.tenant_id = $1::uuid and a.id = $2::uuid and a.status = 'booked' and a.starts_at > now()
    `, [tenant.id, body.appointmentId ?? null]);
    if (!existingResult.rows.length) {
      return { status: "not_found", message: "I could not find that future booked appointment." };
    }
    const existing = existingResult.rows[0];
    const staff = sharedCalendarId(tenant)
      ? salonAsStaff(tenant)
      : (tenant.adapter_config.staff ?? []).find((member) => member.calendarId === existing.staff_calendar_id);
    const start = parseDate(body.newStartTime);
    if (!start || start.getTime() <= Date.now()) {
      return { status: "not_rescheduled", code: "closed", message: "Please choose a valid future time with its Swiss UTC offset." };
    }
    const durationMs = new Date(existing.ends_at).getTime() - new Date(existing.starts_at).getTime();
    const end = new Date(start.getTime() + durationMs);
    const opening = openingValidation(tenant, start, end);
    if (!opening.ok) return { status: "not_rescheduled", code: "closed", message: opening.message };

    let calendarUpdated = false;
    try {
      const outcome = await this.db.transaction(async (tx) => {
        await tx.query("update appointments set status = 'cancelled' where id = $1::uuid", [existing.id]);
        const lock = await this.acquireSlot(tx, tenant, staff, start, end);
        if (!lock.locked) {
          await tx.query("update appointments set status = 'booked' where id = $1::uuid", [existing.id]);
          return { unavailable: true };
        }
        const free = await this.calendar.isAvailable({
          tenantId: tenant.id,
          calendarId: existing.staff_calendar_id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          excludeEventId: existing.external_id
        }, { db: tx });
        if (!free) {
          await tx.query("delete from booking_slot_locks where id = $1::uuid", [lock.lock_id]);
          await tx.query("update appointments set status = 'booked' where id = $1::uuid", [existing.id]);
          return { unavailable: true };
        }

        await this.calendar.updateEvent({
          tenantId: tenant.id,
          calendarId: existing.staff_calendar_id,
          eventId: existing.external_id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          summary: `${existing.service} - ${existing.staff}`,
          description: "Rescheduled by WA AIOS API"
        }, { db: tx });
        calendarUpdated = true;
        const updatedResult = await tx.query(`
          update appointments
          set starts_at = $2::timestamptz, ends_at = $3::timestamptz,
              status = 'booked', status_source = 'workflow'
          where id = $1::uuid
          returning *, id::text as id, contact_id::text as contact_id
        `, [existing.id, start.toISOString(), end.toISOString()]);
        const updated = updatedResult.rows[0];
        await invalidateReminders(tx, existing.id, "rescheduled");
        await scheduleReminders(tx, tenant, { ...updated, contact_first_name: existing.contact_first_name });
        await scheduleCompletionMessage(tx, tenant, { ...updated, contact_first_name: existing.contact_first_name });
        await tx.query(`
          insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
          values ($1::uuid, 'appointment', $2::uuid, 'appointment.rescheduled', 'api.booking', $3::jsonb)
        `, [tenant.id, existing.id, JSON.stringify({ startTime: start.toISOString(), endTime: end.toISOString() })]);
        await tx.query("delete from booking_slot_locks where id = $1::uuid", [lock.lock_id]);
        return { updated };
      });
      if (outcome.unavailable) {
        return { status: "not_rescheduled", code: "slot_unavailable", message: "That new time is not available with the booked stylist." };
      }
      return {
        status: "rescheduled",
        startTime: iso(outcome.updated.starts_at),
        endTime: iso(outcome.updated.ends_at),
        message: "Appointment successfully rescheduled."
      };
    } catch (error) {
      if (calendarUpdated && this.calendar.provider === "google") {
        try {
          await this.calendar.updateEvent({
            tenantId: tenant.id,
            calendarId: existing.staff_calendar_id,
            eventId: existing.external_id,
            startTime: iso(existing.starts_at),
            endTime: iso(existing.ends_at),
            summary: `${existing.service} - ${existing.staff}`,
            description: "Restored after database persistence failure"
          });
        } catch (cleanupError) {
          this.logger.error("Google Calendar reschedule compensation failed", cleanupError);
        }
      }
      this.logger.error("Reschedule failed", error);
      return { status: "not_rescheduled", code: "persistence_failed", message: "I could not safely reschedule that appointment. The salon team will need to help." };
    }
  }

  async cancelAppointment(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    if (!uuidPattern.test(String(body.appointmentId ?? ""))) {
      return { status: "not_found", message: "I could not find that future booked appointment." };
    }
    let existing = null;
    let calendarDeleted = false;
    try {
      const outcome = await this.db.transaction(async (tx) => {
        const result = await tx.query(`
          select *, id::text as id, contact_id::text as contact_id
          from appointments
          where tenant_id = $1::uuid and id = $2::uuid and status = 'booked' and starts_at > now()
        `, [tenant.id, body.appointmentId ?? null]);
        if (!result.rows.length) return { notFound: true };
        existing = result.rows[0];
        await this.calendar.deleteEvent({
          tenantId: tenant.id,
          calendarId: existing.staff_calendar_id,
          eventId: existing.external_id
        }, { db: tx });
        calendarDeleted = true;
        await tx.query(`
          update appointments set status = 'cancelled', status_source = 'workflow' where id = $1::uuid
        `, [existing.id]);
        await invalidateReminders(tx, existing.id, "cancelled");
        await tx.query(`
          insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
          values ($1::uuid, 'appointment', $2::uuid, 'appointment.cancelled', 'api.booking', $3::jsonb)
        `, [tenant.id, existing.id, JSON.stringify({ reason: String(body.reason ?? "") })]);
        return { cancelled: true };
      });
      return outcome.notFound
        ? { status: "not_found", message: "I could not find that future booked appointment." }
        : { status: "cancelled", message: "Your appointment has been cancelled." };
    } catch (error) {
      if (calendarDeleted && existing && this.calendar.provider === "google") {
        try {
          const replacement = await this.calendar.createEvent({
            tenantId: tenant.id,
            calendarId: existing.staff_calendar_id,
            startTime: iso(existing.starts_at),
            endTime: iso(existing.ends_at),
            summary: `${existing.service} - ${existing.staff}`,
            description: "Restored after database persistence failure"
          });
          await this.db.query("update appointments set external_id = $2 where id = $1::uuid", [existing.id, replacement.id]);
        } catch (cleanupError) {
          this.logger.error("Google Calendar cancellation compensation failed", cleanupError);
        }
      }
      this.logger.error("Cancellation failed", error);
      return { status: "not_cancelled", code: "calendar_error", message: "I could not safely cancel that appointment. The salon team will need to help." };
    }
  }

  async logCall(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const outcomeMap = {
      booked: "booked",
      rescheduled: "rescheduled",
      cancelled: "cancelled",
      question_answered: "inquiry",
      transferred: "transferred",
      complaint: "transferred",
      callback_requested: "inquiry",
      abandoned: "missed"
    };
    const outcome = outcomeMap[body.outcome] ?? "inquiry";
    const result = await this.db.transaction(async (tx) => {
      const contactId = await upsertContact(tx, tenant.id, {
        name: body.customerName,
        phone: body.customerPhone,
        whatsappConsent: false
      });
      const call = await tx.query(`
        insert into calls (
          tenant_id, contact_id, retell_call_id, started_at, duration_seconds,
          answered, outcome, transcript, recording_url, disclosure_played
        ) values (
          $1::uuid, $2::uuid, $3, $4::timestamptz, $5::int,
          $6::boolean, $7, nullif($8, ''), nullif($9, ''), $10::boolean
        )
        on conflict (tenant_id, retell_call_id) do update set
          duration_seconds = excluded.duration_seconds,
          answered = excluded.answered,
          outcome = excluded.outcome,
          transcript = excluded.transcript,
          recording_url = excluded.recording_url,
          disclosure_played = excluded.disclosure_played
        returning id::text, disclosure_played
      `, [
        tenant.id,
        contactId,
        String(body.callId ?? randomUUID()),
        body.startedAt && parseDate(body.startedAt) ? body.startedAt : new Date().toISOString(),
        Number(body.durationSeconds ?? 0),
        body.answered ?? outcome !== "missed",
        outcome,
        String(body.summary ?? ""),
        String(body.recordingUrl ?? ""),
        body.disclosurePlayed === true
      ]);
      await tx.query(`
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
        values ($1::uuid, 'call', $2::uuid, 'call.completed', 'retell', $3::jsonb)
      `, [tenant.id, call.rows[0].id, JSON.stringify({ outcome, disclosurePlayed: call.rows[0].disclosure_played })]);
      return call.rows[0];
    });
    return {
      logged: true,
      callId: result.id,
      complianceFlag: result.disclosure_played ? null : "recording_disclosure_missing"
    };
  }

  async logComplaint(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const severity = ["low", "medium", "high", "urgent"].includes(body.severity) ? body.severity : "medium";
    const record = await this.db.transaction(async (tx) => {
      const contactId = await upsertContact(tx, tenant.id, {
        name: body.customerName,
        phone: body.customerPhone,
        whatsappConsent: false
      });
      const complaint = await tx.query(`
        insert into complaints (
          tenant_id, contact_id, source_channel, detected_category, severity, body
        ) values ($1::uuid, $2::uuid, 'phone', 'service_feedback', $3, $4)
        returning id::text, contact_id::text
      `, [tenant.id, contactId, severity, String(body.summary ?? "")]);
      await tx.query(`
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
        values ($1::uuid, 'complaint', $2::uuid, 'complaint.created', 'api.retell', $3::jsonb)
      `, [tenant.id, complaint.rows[0].id, JSON.stringify({ severity })]);
      return { ...complaint.rows[0], first_name: firstName(body.customerName), body: String(body.summary ?? "") };
    });

    const ownerEmail = tenant.review_config.ownerAlertEmail;
    if (ownerEmail) {
      await this.db.transaction(async (tx) => {
        await queueMessage(tx, {
          tenant,
          channel: "email",
          templateId: "complaint_owner_alert",
          scheduledFor: new Date(),
          contact: { first_name: record.first_name },
          complaint: { severity, body: record.body },
          bodyPrefix: `Owner alert to ${ownerEmail}: `
        });
      });
    }
    // Retain the pre-existing API response for clients while the queued worker
    // owns actual delivery. In stub mode that worker will record `stubbed`.
    const ownerAlert = tenant.messaging_config.mode === "stub" ? "stubbed" : "queued";
    return {
      logged: true,
      complaintId: record.id,
      ownerAlert,
      automatedCustomerReply: false
    };
  }

  async recordReviewRating(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const rating = Number(body.rating);
    if (!uuidPattern.test(String(body.appointmentId ?? "")) || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return {
        recorded: false,
        code: "invalid_request",
        message: "Please provide the appointment ID and a whole-number rating from 1 to 5."
      };
    }
    const outcome = await this.db.transaction(async (tx) => {
      const result = await tx.query(`
        select r.id::text, a.id::text as appointment_id, a.contact_id::text as contact_id,
               a.starts_at, a.ends_at, a.service, a.staff, c.first_name
        from reviews r
        join appointments a on a.id = r.appointment_id
        join contacts c on c.id = r.contact_id
        where r.tenant_id = $1::uuid and r.appointment_id = $2::uuid
      `, [tenant.id, body.appointmentId]);
      if (!result.rows.length) return { found: false };
      const appointment = result.rows[0];
      const gateEnabled = tenant.review_config.gateEnabled !== false;
      const threshold = Number(tenant.review_config.threshold ?? 4);
      const routeToGoogle = !gateEnabled || rating >= threshold;
      await tx.query(`
        update reviews
        set rating = $2::smallint,
            routed_to = $3,
            private_feedback = case when $3 = 'private' then nullif($4, '') else private_feedback end
        where id = $1::uuid
      `, [appointment.id, rating, routeToGoogle ? "google" : "private", String(body.privateFeedback ?? "")]);
      await tx.query(`
        update sequence_runs
        set status = 'completed', next_fire_at = null, exit_reason = 'rating_recorded'
        where tenant_id = $1::uuid and appointment_id = $2::uuid
          and sequence_type = 'review_request' and status = 'active'
      `, [tenant.id, appointment.appointment_id]);
      if (routeToGoogle && tenant.review_config.googleReviewUrl) {
        await queueMessage(tx, {
          tenant,
          contactId: appointment.contact_id,
          appointmentId: appointment.appointment_id,
          channel: tenant.review_config.channel || "email",
          templateId: "review_request",
          scheduledFor: new Date(),
          contact: { first_name: appointment.first_name },
          appointment
        });
      }
      return {
        found: true,
        routedTo: routeToGoogle ? "google" : "private",
        url: routeToGoogle ? tenant.review_config.googleReviewUrl : tenant.review_config.privateFeedbackUrl
      };
    });
    if (!outcome.found) {
      return { recorded: false, code: "not_found", message: "I could not find a review request for that appointment." };
    }
    return {
      recorded: true,
      routedTo: outcome.routedTo,
      url: outcome.url || null
    };
  }

  async logCallback(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const eventId = await this.db.transaction(async (tx) => {
      const contactId = await upsertContact(tx, tenant.id, {
        name: body.customerName,
        phone: body.customerPhone,
        whatsappConsent: false
      });
      const event = await tx.query(`
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
        values ($1::uuid, 'callback_request', $2::uuid, 'callback.requested', 'api.retell', $3::jsonb)
        returning id::text
      `, [tenant.id, contactId, JSON.stringify({
        customerName: String(body.customerName ?? ""),
        customerPhone: normalisePhone(body.customerPhone),
        reason: String(body.reason ?? "")
      })]);
      return event.rows[0].id;
    });
    return {
      logged: true,
      callbackRequestId: eventId,
      message: "The callback request has been recorded for the salon team."
    };
  }

  // Appointments whose end time has passed and that were never explicitly
  // marked (no-show / cancelled) are treated as completed. The salon overrides
  // exceptions from the dashboard via markAppointmentOutcome. Completing an
  // appointment updates the customer's lifetime rollups and makes it eligible
  // for the review request (scheduled by sweepReviewRequests in the same cycle).
  async sweepAppointmentOutcomes() {
    const graceMinutes = Number(this.env.APPOINTMENT_COMPLETION_GRACE_MINUTES ?? 15);
    const changed = await this.db.query(`
      with done as (
        update appointments
        set status = 'completed', status_source = 'inferred'
        where status = 'booked'
          and ends_at <= now() - make_interval(mins => $1::int)
        returning tenant_id, id, contact_id, ends_at, service, value_chf
      ), audit as (
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
        select tenant_id, 'appointment', id, 'appointment.completed_inferred', 'api.outcome_sweep',
               jsonb_build_object('endsAt', ends_at)
        from done
      )
      select tenant_id::text, id::text, contact_id::text, ends_at, service, value_chf::float8 as value_chf
      from done
    `, [Math.max(0, Math.min(1440, graceMinutes))]);
    for (const row of changed.rows) {
      await this.db.query(`
        update contacts set
          completed_bookings = completed_bookings + 1,
          lifetime_value_chf = lifetime_value_chf + $2::numeric,
          lifecycle_stage = case when lifecycle_stage in ('lead', 'inactive') then 'active' else lifecycle_stage end,
          last_interaction_at = greatest(coalesce(last_interaction_at, '-infinity'::timestamptz), $3::timestamptz),
          last_interaction_kind = 'appointment',
          updated_at = now()
        where id = $1::uuid
      `, [row.contact_id, row.value_chf, row.ends_at]);
      await this.db.query(`
        insert into contact_notes (tenant_id, contact_id, author, kind, body, metadata)
        values ($1::uuid, $2::uuid, 'system', 'appointment', $3, $4::jsonb)
      `, [row.tenant_id, row.contact_id, `Completed ${row.service}`, JSON.stringify({ appointmentId: row.id })]);
    }
    return changed.rows.map((row) => row.id);
  }

  // Backwards-compatible alias: server.mjs and older callers used this name.
  async sweepNoShows() {
    return this.sweepAppointmentOutcomes();
  }

  // Explicit outcome from the dashboard or a staff webhook.
  async markAppointmentOutcome(tenantId, body) {
    const tenant = await this.tenant(tenantId);
    const outcome = String(body.outcome ?? "").toLowerCase();
    if (!["completed", "no_show", "cancelled"].includes(outcome)) {
      return { updated: false, code: "invalid_request", message: "outcome must be completed, no_show or cancelled." };
    }
    if (!uuidPattern.test(String(body.appointmentId ?? ""))) {
      return { updated: false, code: "not_found", message: "Unknown appointment." };
    }
    return this.db.transaction(async (tx) => {
      const found = await tx.query(`
        select a.*, a.id::text as id, a.contact_id::text as contact_id, c.first_name as contact_first_name
        from appointments a join contacts c on c.id = a.contact_id
        where a.tenant_id = $1::uuid and a.id = $2::uuid
      `, [tenant.id, body.appointmentId]);
      if (!found.rows.length) return { updated: false, code: "not_found", message: "Unknown appointment." };
      const appt = found.rows[0];
      await tx.query("update appointments set status = $2, status_source = 'staff' where id = $1::uuid", [appt.id, outcome]);
      await tx.query(`
        insert into events (tenant_id, aggregate_type, aggregate_id, event_type, source, payload)
        values ($1::uuid, 'appointment', $2::uuid, $3, 'api.dashboard', $4::jsonb)
      `, [tenant.id, appt.id, `appointment.${outcome}`, JSON.stringify({ by: body.by || "staff" })]);
      if (outcome === "no_show") {
        await invalidateReminders(tx, appt.id, "no_show");
        await tx.query("update contacts set no_show_count = no_show_count + 1, updated_at = now() where id = $1::uuid", [appt.contact_id]);
        await scheduleNoShowRecovery(tx, tenant, appt);
      } else if (outcome === "cancelled") {
        await invalidateReminders(tx, appt.id, "cancelled");
      } else {
        await tx.query(`
          update contacts set completed_bookings = completed_bookings + 1,
            lifetime_value_chf = lifetime_value_chf + $2::numeric,
            last_interaction_at = now(), last_interaction_kind = 'appointment', updated_at = now()
          where id = $1::uuid
        `, [appt.contact_id, Number(appt.value_chf ?? 0)]);
      }
      return { updated: true, appointmentId: appt.id, outcome };
    });
  }

  async sweepReviewRequests({ limit = 100 } = {}) {
    const candidates = await this.db.query(`
      select a.tenant_id::text, a.id::text
      from appointments a
      left join reviews r on r.tenant_id = a.tenant_id and r.appointment_id = a.id
      where a.status = 'completed'
        and a.ends_at <= now()
        and r.id is null
      order by a.ends_at
      limit $1
    `, [limit]);
    let scheduled = 0;
    for (const candidate of candidates.rows) {
      const didSchedule = await this.db.transaction(async (tx) => {
        const appointment = await tx.query(`
          select a.*, a.id::text as id, a.contact_id::text as contact_id, c.first_name as contact_first_name
          from appointments a
          join contacts c on c.id = a.contact_id
          where a.tenant_id = $1::uuid and a.id = $2::uuid and a.status = 'completed'
        `, [candidate.tenant_id, candidate.id]);
        if (!appointment.rows.length) return false;
        const tenant = await this.tenant(candidate.tenant_id, tx);
        return scheduleReviewRequest(tx, tenant, appointment.rows[0]);
      });
      if (didSchedule) scheduled += 1;
    }
    return scheduled;
  }
}

export function tenantIdFromRequest(body, url, env = process.env) {
  const deploymentTenantId = env.TENANT_ID || DEFAULT_TENANT_ID;
  if (String(env.ALLOW_REQUEST_TENANT_ID ?? "false").toLowerCase() !== "true") {
    return deploymentTenantId;
  }
  return body.tenantId || body.tenant_id || url.searchParams.get("tenantId") || deploymentTenantId;
}
