import { getSettings, connected } from "../../../lib/api";
import { updateSettings, updateEmailAutomation } from "../../../lib/actions";
import { PageHead, Card, Badge, Offline } from "../../../lib/ui";

export const dynamic = "force-dynamic";

const EMAIL_TYPES: [key: string, label: string, defaultOn: boolean][] = [
  ["confirmation", "Booking confirmation", true],
  ["reminder24h", "24-hour reminder", true],
  ["reminder2h", "2-hour reminder", true],
  ["rescheduled", "Reschedule confirmation", true],
  ["cancelled", "Cancellation confirmation", true],
  ["missedCall", "Missed-call follow-up", true],
  ["leadFollowup", "Lead follow-up", true],
  ["completion", "Post-visit thank-you", true]
];

export default async function SettingsPage() {
  if (!connected) return (<><PageHead title="Settings" /><Offline what="Settings" /></>);
  const { tenant: t, emailAutomation } = await getSettings();
  const contact = (t.contact as Record<string, string>) || {};
  const review = (t.review as Record<string, string>) || {};
  const quiet = (t.quietHours as { start?: string; end?: string }) || {};
  const booking = (t.booking as Record<string, unknown>) || {};
  const services = (t.services as { name: string; durationMinutes?: number; priceChf?: number }[]) || [];
  const messaging = (t.messaging as Record<string, unknown>) || {};
  const emailCfg = ((messaging.email as Record<string, unknown>) || {});
  const ea = emailAutomation;

  return (
    <>
      <PageHead title="Settings" lede="Salon profile, hours, calendar and messaging. Changes apply to the AI receptionist immediately." />

      <form action={updateSettings} className="grid cols-2">
        <Card title="Salon profile">
          <div className="stack" style={{ gap: 10 }}>
            <div className="field"><label>Name</label><input className="input" name="name" defaultValue={String(t.name || "")} /></div>
            <div className="field"><label>Average appointment value (CHF)</label><input className="input" type="number" name="avgAppointmentValueChf" defaultValue={Number(t.avgAppointmentValueChf || 0)} /></div>
            <div className="field"><label>Phone</label><input className="input" name="contact_phone" defaultValue={contact.phone || ""} /></div>
            <div className="field"><label>Transfer-to-human number</label><input className="input" name="contact_transferPhone" defaultValue={contact.transferPhone || ""} /></div>
            <div className="field"><label>Email</label><input className="input" name="contact_email" defaultValue={contact.email || ""} /></div>
            <div className="field"><label>Address</label><input className="input" name="contact_address" defaultValue={contact.address || ""} /></div>
          </div>
        </Card>

        <Card title="Automation & messaging">
          <div className="stack" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 10 }}>
              <div className="field" style={{ flex: 1 }}><label>Quiet hours start</label><input className="input" name="quietStart" defaultValue={quiet.start || "21:00"} /></div>
              <div className="field" style={{ flex: 1 }}><label>Quiet hours end</label><input className="input" name="quietEnd" defaultValue={quiet.end || "08:00"} /></div>
            </div>
            <div className="field"><label>Google review link</label><input className="input" name="review_googleReviewUrl" defaultValue={review.googleReviewUrl || ""} /></div>
            <div className="field"><label>Owner alert email (complaints)</label><input className="input" name="review_ownerAlertEmail" defaultValue={review.ownerAlertEmail || ""} /></div>
            <div className="field"><label>Shared Google Calendar ID</label><input className="input" name="bookingSharedCalendarId" defaultValue={String(booking.sharedCalendarId || "primary")} /></div>
          </div>
        </Card>

        <Card title="Services" sub="Edited in config/tenant.demo.json + redeploy — shown here for reference">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Service</th><th className="num">Duration</th><th className="num">Price</th></tr></thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.name}><td>{s.name}</td><td className="num">{s.durationMinutes ?? 60} min</td><td className="num">{s.priceChf ? `CHF ${s.priceChf}` : "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Connections">
          <div className="stack" style={{ gap: 8, fontSize: 13 }}>
            <div className="spread"><span>Retell agent</span>{t.retellAgentId ? <Badge value="active">{String(t.retellAgentId).slice(0, 18)}…</Badge> : <Badge>not provisioned</Badge>}</div>
            <div className="spread"><span>Calendar</span><Badge value="active">Google · {String(booking.sharedCalendarId || "primary")}</Badge></div>
            <div className="spread"><span>Timezone</span><span className="muted">{String(t.timezone || "Europe/Zurich")}</span></div>
            <div className="spread"><span>Locale</span><span className="muted">{String(t.locale || "de-CH")}</span></div>
          </div>
        </Card>

        <div style={{ gridColumn: "1 / -1" }}>
          <button className="btn primary" type="submit">Save settings</button>
        </div>
      </form>

      <form action={updateEmailAutomation} className="grid cols-2" style={{ marginTop: 20 }}>
        <Card title="Email automation" sub="Operational emails sent by the receptionist">
          <div className="stack" style={{ gap: 12 }}>
            <div className="spread">
              <span>Status</span>
              <Badge value={ea?.status || "unknown"}>
                {ea?.status === "connected" ? "Connected"
                  : ea?.status === "not_configured" ? "Not configured"
                  : ea?.status === "error" ? "Error" : "Unknown"}
              </Badge>
            </div>
            {ea?.detail ? <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>{ea.detail}</p> : null}
            <div className="spread" style={{ fontSize: 13 }}>
              <span className="muted">Provider</span><span>Resend{ea?.apiKeyPresent ? " · API key set" : " · no API key"}</span>
            </div>
            {ea?.recent && ea.recent.total > 0 ? (
              <div className="spread" style={{ fontSize: 13 }}>
                <span className="muted">Last 24h</span>
                <span>{ea.recent.sent} sent · {ea.recent.queued} queued · {ea.recent.failed} failed</span>
              </div>
            ) : null}
            <div className="field">
              <label>Sending address (EMAIL_FROM)</label>
              <input className="input" value={ea?.from || "not set on the API"} readOnly />
            </div>
            <div className="field">
              <label>Reply-to (REPLY_TO_EMAIL)</label>
              <input className="input" value={ea?.replyTo || "not set on the API"} readOnly />
            </div>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              RESEND_API_KEY, EMAIL_FROM and REPLY_TO_EMAIL are set on the API service, not here.
              Per-salon overrides below.
            </p>
            <div className="field">
              <label>This salon&apos;s sending name (optional)</label>
              <input className="input" name="senderName" defaultValue={String(emailCfg.senderName || (messaging.senderName as string) || "")} placeholder={String(t.name || "")} />
            </div>
            <div className="row" style={{ gap: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label>Override from address</label>
                <input className="input" name="from" defaultValue={String(emailCfg.from || "")} placeholder="bookings@your-domain.ch" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>Override reply-to</label>
                <input className="input" name="replyTo" defaultValue={String(emailCfg.replyTo || "")} placeholder="hello@your-domain.ch" />
              </div>
            </div>
          </div>
        </Card>

        <Card title="Which emails to send" sub="Turn individual automations on or off for this salon">
          <div className="stack" style={{ gap: 4 }}>
            {EMAIL_TYPES.map(([key, lbl]) => (
              <label key={key} className="spread" style={{ padding: "9px 0", borderBottom: "1px solid var(--line-soft)", fontSize: 13.5 }}>
                <span>{lbl}</span>
                <input type="checkbox" name={`email_${key}`} defaultChecked={emailCfg[key] !== false} />
              </label>
            ))}
            <div className="field" style={{ marginTop: 12 }}>
              <label>Lead follow-up delay (minutes)</label>
              <input className="input" type="number" name="leadFollowupDelayMinutes" min={1} defaultValue={Number(emailCfg.leadFollowupDelayMinutes) || 30} style={{ maxWidth: 140 }} />
            </div>
          </div>
        </Card>

        <div style={{ gridColumn: "1 / -1" }}>
          <button className="btn primary" type="submit">Save email settings</button>
        </div>
      </form>
    </>
  );
}
