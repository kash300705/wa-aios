// Premium, mobile-friendly transactional email HTML. Single-column 600px table
// layout, all styles inline, no remote images required. Branding (accent colour,
// logo text) and salon contact details come from the tenant row, so every
// white-label client renders in their own identity. The plain-text alternative
// is the existing template body — this module only adds presentation.

const APPOINTMENT_CARD_TEMPLATES = new Set([
  "appointment_confirmation",
  "appointment_rescheduled",
  "appointment_cancelled",
  "appointment_completion",
  "appointment_t_48h",
  "appointment_t_24h",
  "appointment_t_2h"
]);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function isDarkHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 150;
}

function paragraphs(text) {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">${esc(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function appointmentCard(appointment, tenant, accent) {
  if (!appointment?.starts_at && !appointment?.service) return "";
  const tz = tenant.timezone || "Europe/Zurich";
  const when = appointment.starts_at
    ? new Intl.DateTimeFormat(tenant.locale?.startsWith("de") ? "de-CH" : "en-GB", {
        timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric"
      }).format(new Date(appointment.starts_at))
    : "";
  const time = appointment.starts_at
    ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(appointment.starts_at))
    : "";
  const address = tenant.contact_config?.address || tenant.contact_config?.location || "";
  const rows = [
    ["Service", appointment.service],
    ["Date", when],
    ["Time", time],
    ["With", appointment.staff && appointment.staff !== tenant.name ? appointment.staff : null],
    ["Location", address]
  ].filter(([, v]) => v);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;border:1px solid #e8e8ea;border-radius:12px;border-collapse:separate;overflow:hidden;">
      <tr><td style="height:4px;background:${esc(accent)};font-size:0;line-height:0;">&nbsp;</td></tr>
      ${rows.map(([k, v]) => `
        <tr>
          <td style="padding:12px 18px;border-bottom:1px solid #f2f2f4;width:90px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#9a9aa2;vertical-align:top;">${esc(k)}</td>
          <td style="padding:12px 18px;border-bottom:1px solid #f2f2f4;font-size:15px;color:#18181b;font-weight:600;">${esc(v)}</td>
        </tr>`).join("")}
    </table>`;
}

/**
 * @param {object}  input
 * @param {object}  input.tenant     full tenant row (name, locale, timezone, branding, contact_config, links)
 * @param {string}  input.templateId
 * @param {{subject:string, body:string}} input.rendered  output of renderMessageTemplate
 * @param {object}  [input.appointment]
 * @returns {{ subject:string, text:string, html:string }}
 */
export function renderBrandedEmail({ tenant, templateId, rendered, appointment = {} }) {
  const brand = tenant.branding ?? {};
  const accent = /^#?[0-9a-f]{6}$/i.test(String(brand.primary ?? "")) ? (brand.primary.startsWith("#") ? brand.primary : `#${brand.primary}`) : "#111113";
  const headerInk = isDarkHex(accent) ? "#ffffff" : "#111113";
  const salon = String(tenant.name || "Your salon").trim() || "Your salon";
  const logoText = String(brand.logoText || salon).trim();
  const phone = tenant.contact_config?.phone || "";
  const address = tenant.contact_config?.address || "";
  const subject = rendered.subject || `Message from ${salon}`;
  const preheader = String(rendered.body ?? "").replace(/\s+/g, " ").slice(0, 140);
  const card = APPOINTMENT_CARD_TEMPLATES.has(templateId) ? appointmentCard(appointment, tenant, accent) : "";

  const html = `<!doctype html>
<html lang="${esc(tenant.locale || "de-CH")}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;-webkit-font-smoothing:antialiased;">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #ececed;border-collapse:separate;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:${esc(accent)};padding:22px 32px;">
        <div style="font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${headerInk};">${esc(logoText)}</div>
      </td></tr>
      <tr><td style="padding:32px 32px 8px;">
        ${paragraphs(rendered.body)}
        ${card}
      </td></tr>
      <tr><td style="padding:8px 32px 32px;">
        <hr style="border:none;border-top:1px solid #f0f0f2;margin:8px 0 18px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#9a9aa2;">
          ${esc(salon)}${address ? ` · ${esc(address)}` : ""}${phone ? ` · ${esc(phone)}` : ""}
        </p>
        <p style="margin:6px 0 0;font-size:12px;line-height:1.6;color:#b4b4bb;">
          You're receiving this because of an appointment or enquiry with ${esc(salon)}.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return { subject, text: rendered.body, html };
}
