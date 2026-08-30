import { jsonValue } from "./database.mjs";
import { formatSpoken } from "./time.mjs";

const defaultTemplates = {
  "de-CH": {
    appointment_confirmation: {
      subject: "Ihr Termin bei {{salonName}} ist bestätigt",
      body: "Guten Tag {{firstName}}, Ihr Termin für {{service}} bei {{staff}} am {{appointmentTime}} ist bestätigt. Wir freuen uns auf Sie bei {{salonName}}. Antworten Sie einfach auf diese Nachricht, falls sich etwas ändert.",
      whatsapp: { name: "appointment_confirmation", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    appointment_completion: {
      subject: "Danke für Ihren Besuch bei {{salonName}}",
      body: "Guten Tag {{firstName}}, danke, dass Sie heute für {{service}} bei uns waren. Wir hoffen, Sie sind rundum zufrieden. Bis zum nächsten Mal bei {{salonName}}.",
      whatsapp: { name: "appointment_completion", bodyParameters: ["firstName", "service"] }
    },
    appointment_rescheduled: {
      subject: "Ihr Termin bei {{salonName}} wurde verschoben",
      body: "Guten Tag {{firstName}}, Ihr Termin für {{service}} bei {{salonName}} wurde verschoben. Neuer Termin: {{appointmentTime}} bei {{staff}}{{addressPhrase}}. Falls das nicht passt, antworten Sie einfach auf diese Nachricht.",
      whatsapp: { name: "appointment_rescheduled", bodyParameters: ["firstName", "service", "appointmentTime", "staff"] }
    },
    appointment_cancelled: {
      subject: "Ihr Termin bei {{salonName}} wurde storniert",
      body: "Guten Tag {{firstName}}, Ihr Termin für {{service}} am {{appointmentTime}} bei {{salonName}} wurde storniert. Möchten Sie einen neuen Termin? Antworten Sie auf diese Nachricht oder rufen Sie uns an unter {{salonPhone}}.",
      whatsapp: { name: "appointment_cancelled", bodyParameters: ["firstName", "service", "appointmentTime", "salonPhone"] }
    },
    missed_call: {
      subject: "Wir haben Ihren Anruf verpasst — {{salonName}}",
      body: "Guten Tag {{firstName}}, Sie haben vorhin bei {{salonName}} angerufen und wir konnten leider nicht abnehmen. Antworten Sie einfach auf diese E-Mail oder rufen Sie uns zurück unter {{salonPhone}} — wir helfen Ihnen gern weiter.",
      whatsapp: { name: "missed_call", bodyParameters: ["firstName", "salonPhone"] }
    },
    lead_followup: {
      subject: "Ihre Anfrage bei {{salonName}}",
      body: "Guten Tag {{firstName}}, danke für Ihre Anfrage{{serviceInterestPhrase}}. Wir haben aktuell freie Termine — antworten Sie einfach mit Ihrem Wunschtag oder rufen Sie uns an unter {{salonPhone}}, dann finden wir gemeinsam einen passenden Termin.",
      whatsapp: { name: "lead_followup", bodyParameters: ["firstName", "serviceInterestPhrase", "salonPhone"] }
    },
    reactivation_intro: {
      subject: "Wir würden Sie gern wiedersehen, {{firstName}}",
      body: "Guten Tag {{firstName}}, es ist eine Weile her seit Ihrem letzten Besuch bei {{salonName}}{{lastServicePhrase}}. Wir haben aktuell wieder freie Termine — antworten Sie einfach, wenn Sie einen Platz möchten.{{offerPhrase}}",
      whatsapp: { name: "reactivation_intro", bodyParameters: ["firstName", "lastServicePhrase", "offerPhrase"] }
    },
    appointment_t_48h: {
      subject: "Ihr Termin bei {{salonName}} in zwei Tagen",
      body: "Guten Tag {{firstName}}, wir freuen uns auf Ihren Termin für {{service}} bei {{staff}} am {{appointmentTime}}. Falls etwas dazwischenkommt, melden Sie sich bitte rechtzeitig bei uns.",
      whatsapp: { name: "appointment_t_48h", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    appointment_t_24h: {
      subject: "Erinnerung: Ihr Termin morgen bei {{salonName}}",
      body: "Guten Tag {{firstName}}, dies ist die Erinnerung an Ihren Termin für {{service}} bei {{staff}} morgen, {{appointmentTime}}. Wir freuen uns auf Sie.",
      whatsapp: { name: "appointment_t_24h", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    appointment_t_2h: {
      subject: "Ihr Termin beginnt in zwei Stunden",
      body: "Guten Tag {{firstName}}, Ihr Termin für {{service}} bei {{staff}} beginnt in zwei Stunden, {{appointmentTime}}. Bis bald bei {{salonName}}.",
      whatsapp: { name: "appointment_t_2h", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    no_show_t_30m: {
      subject: "Wir haben Sie heute vermisst",
      body: "Guten Tag {{firstName}}, wir haben Sie heute zu Ihrem Termin für {{service}} vermisst. Wenn Sie möchten, finden wir gern einen neuen Termin für Sie.",
      whatsapp: { name: "no_show_t_30m", bodyParameters: ["firstName", "service"] }
    },
    no_show_day_1: {
      subject: "Möchten Sie einen neuen Termin?",
      body: "Guten Tag {{firstName}}, für Ihren verpassten Termin für {{service}} finden wir gern einen neuen passenden Zeitpunkt. Antworten Sie auf diese Nachricht oder rufen Sie uns an.",
      whatsapp: { name: "no_show_day_1", bodyParameters: ["firstName", "service"] }
    },
    no_show_day_3: {
      subject: "Ihr Termin bei {{salonName}}",
      body: "Guten Tag {{firstName}}, wir möchten Ihnen die Möglichkeit geben, Ihren Termin für {{service}} unkompliziert neu zu buchen. Unser Team hilft Ihnen gern weiter.",
      whatsapp: { name: "no_show_day_3", bodyParameters: ["firstName", "service"] }
    },
    no_show_day_7: {
      subject: "Letzte Erinnerung zur Neubuchung",
      body: "Guten Tag {{firstName}}, falls Sie weiterhin einen Termin für {{service}} wünschen, sind wir gern für Sie da. Diese Nachricht ist unsere letzte Erinnerung.",
      whatsapp: { name: "no_show_day_7", bodyParameters: ["firstName", "service"] }
    },
    review_rating_gate: {
      subject: "Wie war Ihr Termin bei {{salonName}}?",
      body: "Guten Tag {{firstName}}, danke für Ihren Besuch bei {{salonName}}. Wie zufrieden waren Sie mit {{service}}? Bitte geben Sie uns eine Bewertung von 1 bis 5: {{ratingUrl}}",
      whatsapp: { name: "review_rating_gate", bodyParameters: ["firstName", "service", "ratingUrl"] }
    },
    review_request: {
      subject: "Danke für Ihre Rückmeldung",
      body: "Guten Tag {{firstName}}, danke für Ihren Besuch bei {{salonName}}. Ihre Rückmeldung zu {{service}} hilft uns sehr: {{reviewUrl}}",
      whatsapp: { name: "review_request", bodyParameters: ["firstName", "service", "reviewUrl"] }
    },
    lead_followup_instant: {
      subject: "Ihre Anfrage bei {{salonName}}",
      body: "Guten Tag {{firstName}}, danke für Ihre Anfrage{{serviceInterestPhrase}}. Wir haben gerade freie Termine — antworten Sie mit Ihrem Wunschtag oder buchen Sie direkt: {{bookingUrl}}",
      whatsapp: { name: "lead_followup_instant", bodyParameters: ["firstName", "serviceInterestPhrase", "bookingUrl"] }
    },
    lead_followup_10min: {
      subject: "Wir sind für Sie da, {{firstName}}",
      body: "Guten Tag {{firstName}}, wir wollten kurz sicherstellen, dass Ihre Anfrage{{serviceInterestPhrase}} bei uns angekommen ist. Schreiben Sie uns einfach Ihren Wunschtag, dann kümmern wir uns sofort darum.",
      whatsapp: { name: "lead_followup_10min", bodyParameters: ["firstName", "serviceInterestPhrase"] }
    },
    lead_followup_2h: {
      subject: "Noch da? Ihr Termin bei {{salonName}}",
      body: "Guten Tag {{firstName}}, falls es vorhin nicht gepasst hat: Wir haben diese Woche noch Plätze frei{{serviceInterestPhrase}}. Ein kurzes Wort von Ihnen genügt und wir schlagen Ihnen passende Zeiten vor.",
      whatsapp: { name: "lead_followup_2h", bodyParameters: ["firstName", "serviceInterestPhrase"] }
    },
    lead_followup_day_1: {
      subject: "Noch Interesse an einem Termin?",
      body: "Guten Tag {{firstName}}, gestern haben Sie sich bei {{salonName}} gemeldet{{serviceInterestPhrase}}. Sollen wir Ihnen zwei, drei passende Zeiten vorschlagen? Einfach kurz antworten.",
      whatsapp: { name: "lead_followup_day_1", bodyParameters: ["firstName", "serviceInterestPhrase"] }
    },
    lead_followup_day_3: {
      subject: "Ihr Termin bei {{salonName}}",
      body: "Guten Tag {{firstName}}, diese Woche haben wir noch freie Plätze{{serviceInterestPhrase}}. Wenn Sie möchten, reservieren wir Ihnen gern einen: {{bookingUrl}}",
      whatsapp: { name: "lead_followup_day_3", bodyParameters: ["firstName", "serviceInterestPhrase", "bookingUrl"] }
    },
    lead_reengage_day_7: {
      subject: "Wir sind da, wenn es passt",
      body: "Guten Tag {{firstName}}, kein Stress — wenn der Zeitpunkt für Ihren Termin bei {{salonName}} passt, sind wir für Sie da. Antworten Sie einfach auf diese Nachricht.",
      whatsapp: { name: "lead_reengage_day_7", bodyParameters: ["firstName"] }
    },
    lead_reengage_day_14: {
      subject: "Letzte Nachricht von {{salonName}}",
      body: "Guten Tag {{firstName}}, das ist unsere letzte Nachricht zu Ihrer Anfrage. Falls Sie später einen Termin wünschen, erreichen Sie uns jederzeit unter {{salonPhone}}. Alles Gute!",
      whatsapp: { name: "lead_reengage_day_14", bodyParameters: ["firstName", "salonPhone"] }
    },
    complaint_owner_alert: {
      subject: "Neue Kundenbeschwerde: {{severity}}",
      body: "Neue Kundenbeschwerde von {{firstName}}. Einstufung: {{severity}}. Anliegen: {{complaintBody}}. Bitte persönlich prüfen und nachfassen.",
      whatsapp: { name: "complaint_owner_alert", bodyParameters: ["firstName", "severity", "complaintBody"] }
    }
  },
  en: {
    appointment_confirmation: {
      subject: "Your {{salonName}} appointment is confirmed",
      body: "Hello {{firstName}}, your {{service}} appointment with {{staff}} on {{appointmentTime}} is confirmed. We look forward to seeing you at {{salonName}}. Just reply to this message if anything changes.",
      whatsapp: { name: "appointment_confirmation", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    appointment_completion: {
      subject: "Thank you for visiting {{salonName}}",
      body: "Hello {{firstName}}, thank you for coming in for {{service}} today. We hope you're delighted with the result. See you next time at {{salonName}}.",
      whatsapp: { name: "appointment_completion", bodyParameters: ["firstName", "service"] }
    },
    appointment_rescheduled: {
      subject: "Your {{salonName}} appointment has been moved",
      body: "Hello {{firstName}}, your {{service}} appointment at {{salonName}} has been rescheduled. New time: {{appointmentTime}} with {{staff}}{{addressPhrase}}. If that doesn't work, just reply to this message.",
      whatsapp: { name: "appointment_rescheduled", bodyParameters: ["firstName", "service", "appointmentTime", "staff"] }
    },
    appointment_cancelled: {
      subject: "Your {{salonName}} appointment has been cancelled",
      body: "Hello {{firstName}}, your {{service}} appointment on {{appointmentTime}} at {{salonName}} has been cancelled. Would you like a new time? Reply to this message or call us on {{salonPhone}}.",
      whatsapp: { name: "appointment_cancelled", bodyParameters: ["firstName", "service", "appointmentTime", "salonPhone"] }
    },
    missed_call: {
      subject: "Sorry we missed your call — {{salonName}}",
      body: "Hello {{firstName}}, you called {{salonName}} earlier and we couldn't pick up. Just reply to this email or call us back on {{salonPhone}} — we'll be happy to help.",
      whatsapp: { name: "missed_call", bodyParameters: ["firstName", "salonPhone"] }
    },
    lead_followup: {
      subject: "Your enquiry at {{salonName}}",
      body: "Hello {{firstName}}, thanks for getting in touch{{serviceInterestPhrase}}. We have openings coming up — reply with a day that suits you, or call us on {{salonPhone}} and we'll find a time together.",
      whatsapp: { name: "lead_followup", bodyParameters: ["firstName", "serviceInterestPhrase", "salonPhone"] }
    },
    reactivation_intro: {
      subject: "We'd love to see you again, {{firstName}}",
      body: "Hello {{firstName}}, it's been a while since your last visit to {{salonName}}{{lastServicePhrase}}. We have openings again — just reply if you'd like us to hold a spot for you.{{offerPhrase}}",
      whatsapp: { name: "reactivation_intro", bodyParameters: ["firstName", "lastServicePhrase", "offerPhrase"] }
    },
    appointment_t_48h: {
      subject: "Your {{salonName}} appointment is in two days",
      body: "Hello {{firstName}}, we look forward to seeing you for {{service}} with {{staff}} on {{appointmentTime}}. Please let us know in good time if your plans change.",
      whatsapp: { name: "appointment_t_48h", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    appointment_t_24h: {
      subject: "Reminder: your {{salonName}} appointment is tomorrow",
      body: "Hello {{firstName}}, this is a reminder for your {{service}} appointment with {{staff}} tomorrow, {{appointmentTime}}. We look forward to seeing you.",
      whatsapp: { name: "appointment_t_24h", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    appointment_t_2h: {
      subject: "Your appointment starts in two hours",
      body: "Hello {{firstName}}, your {{service}} appointment with {{staff}} starts in two hours, {{appointmentTime}}. See you soon at {{salonName}}.",
      whatsapp: { name: "appointment_t_2h", bodyParameters: ["firstName", "service", "staff", "appointmentTime"] }
    },
    no_show_t_30m: {
      subject: "We missed you today",
      body: "Hello {{firstName}}, we missed you at your {{service}} appointment today. If you would like, we can help you find a new time.",
      whatsapp: { name: "no_show_t_30m", bodyParameters: ["firstName", "service"] }
    },
    no_show_day_1: {
      subject: "Would you like to rebook?",
      body: "Hello {{firstName}}, we can help you find a new time for your missed {{service}} appointment. Reply to this message or call us when you are ready.",
      whatsapp: { name: "no_show_day_1", bodyParameters: ["firstName", "service"] }
    },
    no_show_day_3: {
      subject: "Your {{salonName}} appointment",
      body: "Hello {{firstName}}, if you still need {{service}}, we would be happy to help you rebook at a suitable time.",
      whatsapp: { name: "no_show_day_3", bodyParameters: ["firstName", "service"] }
    },
    no_show_day_7: {
      subject: "Final rebooking reminder",
      body: "Hello {{firstName}}, if you would still like {{service}}, our team is here to help. This is our final reminder about the missed appointment.",
      whatsapp: { name: "no_show_day_7", bodyParameters: ["firstName", "service"] }
    },
    review_rating_gate: {
      subject: "How was your visit to {{salonName}}?",
      body: "Hello {{firstName}}, thank you for visiting {{salonName}}. How satisfied were you with {{service}}? Please rate your experience from 1 to 5: {{ratingUrl}}",
      whatsapp: { name: "review_rating_gate", bodyParameters: ["firstName", "service", "ratingUrl"] }
    },
    review_request: {
      subject: "Thank you for your feedback",
      body: "Hello {{firstName}}, thank you for visiting {{salonName}}. Your feedback about {{service}} helps us greatly: {{reviewUrl}}",
      whatsapp: { name: "review_request", bodyParameters: ["firstName", "service", "reviewUrl"] }
    },
    lead_followup_instant: {
      subject: "Your enquiry at {{salonName}}",
      body: "Hello {{firstName}}, thanks for getting in touch{{serviceInterestPhrase}}. We have openings right now — reply with a day that suits you, or book directly: {{bookingUrl}}",
      whatsapp: { name: "lead_followup_instant", bodyParameters: ["firstName", "serviceInterestPhrase", "bookingUrl"] }
    },
    lead_followup_10min: {
      subject: "We're on it, {{firstName}}",
      body: "Hello {{firstName}}, just making sure your enquiry{{serviceInterestPhrase}} reached us. Send us a day that suits you and we'll sort it straight away.",
      whatsapp: { name: "lead_followup_10min", bodyParameters: ["firstName", "serviceInterestPhrase"] }
    },
    lead_followup_2h: {
      subject: "Still there? Your {{salonName}} appointment",
      body: "Hello {{firstName}}, if earlier wasn't a good time — we still have space this week{{serviceInterestPhrase}}. One word from you and we'll suggest some times.",
      whatsapp: { name: "lead_followup_2h", bodyParameters: ["firstName", "serviceInterestPhrase"] }
    },
    lead_followup_day_1: {
      subject: "Still keen on an appointment?",
      body: "Hello {{firstName}}, you contacted {{salonName}} yesterday{{serviceInterestPhrase}}. Shall we suggest two or three times that work? Just reply.",
      whatsapp: { name: "lead_followup_day_1", bodyParameters: ["firstName", "serviceInterestPhrase"] }
    },
    lead_followup_day_3: {
      subject: "Your appointment at {{salonName}}",
      body: "Hello {{firstName}}, we still have space this week{{serviceInterestPhrase}}. Happy to hold one for you: {{bookingUrl}}",
      whatsapp: { name: "lead_followup_day_3", bodyParameters: ["firstName", "serviceInterestPhrase", "bookingUrl"] }
    },
    lead_reengage_day_7: {
      subject: "Here when it suits",
      body: "Hello {{firstName}}, no pressure — whenever the timing is right for your appointment at {{salonName}}, we're here. Just reply to this message.",
      whatsapp: { name: "lead_reengage_day_7", bodyParameters: ["firstName"] }
    },
    lead_reengage_day_14: {
      subject: "Last note from {{salonName}}",
      body: "Hello {{firstName}}, this is our last message about your enquiry. If you'd like an appointment later on, you can always reach us on {{salonPhone}}. All the best!",
      whatsapp: { name: "lead_reengage_day_14", bodyParameters: ["firstName", "salonPhone"] }
    },
    complaint_owner_alert: {
      subject: "New customer complaint: {{severity}}",
      body: "New customer complaint from {{firstName}}. Severity: {{severity}}. Concern: {{complaintBody}}. Please review and follow up personally.",
      whatsapp: { name: "complaint_owner_alert", bodyParameters: ["firstName", "severity", "complaintBody"] }
    }
  }
};

function replaceTokens(value, variables) {
  return String(value ?? "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, name) => String(variables[name] ?? ""));
}

// Per-tenant kill switch for an operational email type. Default on.
// tenant.messaging_config.email = { confirmation, reminder24h, reminder2h,
//   reminder48h, rescheduled, cancelled, missedCall, leadFollowup, completion }
export function emailTypeEnabled(tenant, key) {
  const cfg = tenant?.messaging_config?.email;
  if (!cfg || typeof cfg !== "object") return true;
  return cfg[key] !== false;
}

function customTemplates(tenant) {
  return jsonValue(tenant?.messaging_config, {}).templates ?? {};
}

function templateForLocale(templates, locale, fallbackLocale, templateId) {
  return templates?.[locale]?.[templateId]
    ?? templates?.[fallbackLocale]?.[templateId]
    ?? templates?.en?.[templateId]
    ?? null;
}

export function renderMessageTemplate({ tenant, templateId, contact = {}, appointment = {}, complaint = {}, lead = {} }) {
  const locale = tenant.locale || "de-CH";
  const fallbackLocale = tenant.fallback_locale || "en";
  const custom = templateForLocale(customTemplates(tenant), locale, fallbackLocale, templateId);
  const fallback = templateForLocale(defaultTemplates, locale, fallbackLocale, templateId);
  if (!fallback && !custom) throw new Error(`No message template exists for ${templateId}.`);
  const template = {
    ...fallback,
    ...custom,
    whatsapp: { ...fallback?.whatsapp, ...custom?.whatsapp }
  };
  const review = tenant.review_config ?? {};
  const scheduledAppointmentTime = appointment.starts_at
    ? formatSpoken(appointment.starts_at, tenant.timezone || "Europe/Zurich")
    : "";
  const salonAddress = tenant.contact_config?.address || tenant.contact_config?.location || "";
  const variables = {
    salonName: tenant.name || "the salon",
    firstName: contact.first_name || "there",
    service: appointment.service || "your appointment",
    staff: appointment.staff || "our team",
    appointmentTime: scheduledAppointmentTime,
    address: salonAddress,
    addressPhrase: salonAddress
      ? (String(locale).startsWith("de") ? ` (Adresse: ${salonAddress})` : ` (address: ${salonAddress})`)
      : "",
    severity: complaint.severity || "medium",
    complaintBody: complaint.body || "No details supplied.",
    ratingUrl: review.privateFeedbackUrl || review.private_feedback_url || "",
    reviewUrl: review.googleReviewUrl || review.google_review_url || review.privateFeedbackUrl || "",
    bookingUrl: tenant.links?.booking || tenant.links?.bookingUrl || tenant.contact_config?.phone || "",
    salonPhone: tenant.contact_config?.phone || "",
    serviceInterestPhrase: (lead.serviceInterest || appointment.service)
      ? (String(locale).startsWith("de") ? ` zu ${lead.serviceInterest || appointment.service}` : ` about ${lead.serviceInterest || appointment.service}`)
      : "",
    lastServicePhrase: lead.lastService
      ? (String(locale).startsWith("de") ? ` (zuletzt ${lead.lastService})` : ` (last time: ${lead.lastService})`)
      : "",
    offerPhrase: lead.offer
      ? (String(locale).startsWith("de") ? ` ${lead.offer}` : ` ${lead.offer}`)
      : ""
  };
  return {
    locale: custom ? locale : (fallbackLocale || "en"),
    subject: replaceTokens(template.subject, variables),
    body: replaceTokens(template.body, variables),
    whatsapp: {
      name: template.whatsapp?.name || templateId,
      languageCode: template.whatsapp?.languageCode || locale.replace("-", "_"),
      bodyParameters: (template.whatsapp?.bodyParameters ?? []).map((key) => String(variables[key] ?? ""))
    }
  };
}

