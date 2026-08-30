import Link from "next/link";
import { notFound } from "next/navigation";
import { getCustomer, connected } from "../../../../lib/api";
import { createNote, updateCustomer, setAppointmentOutcome } from "../../../../lib/actions";
import { fmt, label, CHANNEL_LABEL } from "../../../../lib/format";
import { Card, PageHead, Stat, Badge, Empty, Avatar, Offline, CallTranscript, Recording } from "../../../../lib/ui";

export const dynamic = "force-dynamic";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!connected) return (<><PageHead title="Customer" /><Offline what="The customer profile" /></>);
  const data = await getCustomer(id);
  if (data.error === "not_found" || !data.contact) notFound();

  const c = data.contact as Record<string, any>;
  const name = fmt.name(c.first_name, c.last_name);

  // Merge a lightweight timeline from the sub-collections.
  type T = { at: string; kind: string; text: string; tone?: string };
  const timeline: T[] = [
    ...data.appointments.map((a) => ({ at: a.starts_at, kind: "appointment", text: `${label(a.status)} — ${a.service} with ${a.staff}`, tone: a.status })),
    ...data.calls.map((k) => ({ at: k.started_at, kind: "call", text: `Call (${label(k.outcome || "inquiry")}) — ${k.summary || fmt.dur(k.duration_seconds)}` })),
    ...data.messages.filter((mm) => mm.direction === "inbound" || mm.delivery_status !== "queued").map((mm) => ({
      at: mm.sent_at || mm.created_at, kind: "message",
      text: `${mm.direction === "inbound" ? "↙ from customer" : mm.ai_generated ? "↗ AI reply" : "↗ sent"} · ${mm.body.slice(0, 120)}`
    })),
    // System notes of kind appointment/call/message just echo rows already shown
    // above — keep only genuine notes and status changes in the timeline.
    ...data.notes
      .filter((n) => n.author === "staff" || ["note", "status", "reactivation", "lead"].includes(n.kind))
      .map((n) => ({ at: n.created_at, kind: "note", text: `${n.author === "staff" ? "Note" : label(n.kind)} — ${n.body}` }))
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 40);

  return (
    <>
      <PageHead title={name} lede={`${label(c.lifecycle_stage)} · ${CHANNEL_LABEL[c.source] || c.source} origin · added ${fmt.date(c.created_at)}`}>
        <Link className="btn" href="/customers">← All customers</Link>
      </PageHead>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat k="Lifetime value" v={fmt.chf(c.lifetime_value_chf)} />
        <Stat k="Completed visits" v={fmt.int(c.completed_bookings)} foot={`${c.total_bookings} booked · ${c.no_show_count} no-show`} />
        <Stat k="Last visit" v={c.last_booked_at ? fmt.date(c.last_booked_at) : "—"} foot={fmt.rel(c.last_interaction_at)} />
        <Stat k="Contact" v={<span style={{ fontSize: 15 }}>{c.phone_e164 || c.email || "—"}</span>} foot={c.email && c.phone_e164 ? c.email : c.marketing_opt_out ? "Opted out of marketing" : ""} />
      </div>

      <div className="grid cols-2">
        <div className="stack">
          <Card title="Timeline">
            {timeline.length ? (
              <div className="timeline">
                {timeline.map((t, i) => (
                  <div className="tl-item" key={i}>
                    <div className="dotcol"><span className="tl-dot" style={{ background: t.tone === "no_show" ? "var(--bad)" : t.tone === "completed" ? "var(--ok)" : "var(--brand)" }} />{i < timeline.length - 1 ? <span className="tl-line" /> : null}</div>
                    <div className="tl-body">{t.text}<div className="tl-time">{fmt.dateTime(t.at)} · {t.kind}</div></div>
                  </div>
                ))}
              </div>
            ) : <Empty>No history yet.</Empty>}
          </Card>

          <Card title="Appointments">
            {data.appointments.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {data.appointments.slice(0, 12).map((a) => (
                  <div key={a.id} className="spread" style={{ padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <span>
                      <div>{a.service} <span className="muted">· {a.staff}</span></div>
                      <div className="cell-sub">{fmt.dateTime(a.starts_at)}</div>
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      <Badge value={a.status} />
                      {a.status === "booked" && new Date(a.ends_at) < new Date() ? (
                        <form action={setAppointmentOutcome}>
                          <input type="hidden" name="appointmentId" value={a.id} />
                          <input type="hidden" name="outcome" value="completed" />
                          <button className="btn sm" type="submit">Mark done</button>
                        </form>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : <Empty>No appointments.</Empty>}
          </Card>

          <Card title="Calls" action={<Link className="btn sm ghost" href="/calls">All calls →</Link>}>
            {data.calls.length ? (
              <div className="call-list">
                {data.calls.map((k) => {
                  const hasTranscript = Boolean(k.transcript && k.transcript !== "[Demo transcript omitted]");
                  return (
                    <details key={k.id} className="call-row" open={data.calls.length === 1 && hasTranscript}>
                      <summary>
                        <span className="cr-when">
                          <span className="cell-strong">{fmt.dateTime(k.started_at)}</span>
                          <span className="cell-sub">{fmt.dur(k.duration_seconds)}</span>
                        </span>
                        <Badge value={k.outcome || "inquiry"} />
                        {k.user_sentiment ? <Badge value={k.user_sentiment}>{k.user_sentiment}</Badge> : null}
                        <span className="cr-summary muted">{k.summary || (hasTranscript ? "" : "no summary")}</span>
                        <span className="cr-flags">
                          {k.recording_url ? <span className="badge info">▶</span> : null}
                          {hasTranscript ? <span className="badge ok">transcript</span> : null}
                        </span>
                      </summary>
                      <div className="call-detail">
                        <Recording url={k.recording_url} />
                        {k.summary ? <p className="cd-summary">{k.summary}</p> : null}
                        <CallTranscript text={k.transcript} />
                      </div>
                    </details>
                  );
                })}
              </div>
            ) : <Empty>No calls.</Empty>}
          </Card>
        </div>

        <div className="stack">
          <Card title="Add note">
            <form action={createNote} className="stack" style={{ gap: 8 }}>
              <input type="hidden" name="contactId" value={id} />
              <textarea className="textarea" name="body" placeholder="e.g. Prefers morning appointments, allergic to ammonia…" required />
              <div className="row spread">
                <label className="row" style={{ gap: 6, fontSize: 12 }}><input type="checkbox" name="pinned" /> Pin</label>
                <button className="btn primary sm" type="submit">Save note</button>
              </div>
            </form>
          </Card>

          <Card title="Customer settings">
            <form action={updateCustomer} className="stack" style={{ gap: 10 }}>
              <input type="hidden" name="contactId" value={id} />
              <div className="field">
                <label>Lifecycle stage</label>
                <select className="select" name="lifecycleStage" defaultValue={c.lifecycle_stage}>
                  {["lead", "active", "inactive", "vip"].map((s) => <option key={s} value={s}>{label(s)}</option>)}
                </select>
              </div>
              <label className="row" style={{ gap: 8, fontSize: 13 }}>
                <input type="checkbox" name="marketingOptOut" defaultChecked={c.marketing_opt_out} /> Exclude from marketing & reactivation
              </label>
              <button className="btn sm" type="submit">Update</button>
            </form>
          </Card>

          {data.notes.length ? (
            <Card title="Notes">
              <div className="stack" style={{ gap: 8 }}>
                {data.notes.map((n) => (
                  <div key={n.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
                    <div style={{ fontSize: 13 }}>{n.pinned ? "📌 " : ""}{n.body}</div>
                    <div className="cell-sub">{n.author} · {fmt.dateTime(n.created_at)}</div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {data.sequences.filter((s) => s.status === "active").length ? (
            <Card title="Active automations">
              <div className="stack" style={{ gap: 6 }}>
                {data.sequences.filter((s) => s.status === "active").map((s) => (
                  <div key={s.id} className="spread">
                    <span>{label(s.sequence_type)} <span className="muted">· {label(s.current_step)}</span></span>
                    <span className="muted">{fmt.rel(s.next_fire_at)}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
