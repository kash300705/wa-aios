import Link from "next/link";
import { getCalls, connected } from "../../../lib/api";
import { fmt, label } from "../../../lib/format";
import { PageHead, Stat, Badge, Offline, Empty, CallTranscript, Recording } from "../../../lib/ui";

export const dynamic = "force-dynamic";

export default async function CallsPage() {
  if (!connected) return (<><PageHead title="Calls" /><Offline what="The call log" /></>);
  const { calls, stats } = await getCalls();
  const real = calls.filter((c) => c.transcript && c.transcript !== "[Demo transcript omitted]");

  return (
    <>
      <PageHead title="Calls" lede="Every call the AI receptionist handled. Click a call to read the transcript and play the recording." />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <Stat k="Calls · 30 days" v={fmt.int(stats.total)} />
        <Stat k="Answered" v={stats.total ? fmt.pct((stats.answered / stats.total) * 100) : "—"} foot={`${stats.answered} answered`} />
        <Stat k="Booked on call" v={fmt.int(stats.booked)} foot={`${stats.transferred} transferred`} />
        <Stat k="With transcript" v={fmt.int(stats.with_transcript)} foot={`avg ${fmt.dur(stats.avg_duration)}`} />
      </div>

      {calls.length ? (
        <div className="call-list">
          {calls.map((c) => {
            const hasTranscript = Boolean(c.transcript && c.transcript !== "[Demo transcript omitted]");
            return (
              <details key={c.id} className="call-row" open={real.length <= 3 && hasTranscript}>
                <summary>
                  <span className="cr-when">
                    <span className="cell-strong">{fmt.dateTime(c.started_at)}</span>
                    <span className="cell-sub">{fmt.dur(c.duration_seconds)} · {c.direction || "inbound"}</span>
                  </span>
                  <span className="cr-who">
                    <span>{fmt.name(c.first_name, c.last_name)}</span>
                    <span className="cell-sub mono">{c.from_number && c.from_number !== "+0" ? c.from_number : c.phone_e164 || "—"}</span>
                  </span>
                  <Badge value={c.outcome || "inquiry"} />
                  {c.user_sentiment ? <Badge value={c.user_sentiment}>{c.user_sentiment}</Badge> : null}
                  <span className="cr-summary muted">{c.summary || (hasTranscript ? "" : "no summary")}</span>
                  <span className="cr-flags">
                    {c.recording_url ? <span className="badge info">▶ recording</span> : null}
                    {hasTranscript ? <span className="badge ok">transcript</span> : null}
                    {!c.disclosure_played ? <span className="badge bad" title="Recording disclosure not detected">⚠ disclosure</span> : null}
                  </span>
                </summary>

                <div className="call-detail">
                  <div className="cd-meta">
                    {c.appointment_id ? (
                      <span>Booked: <Link href={c.contact_id ? `/customers/${c.contact_id}` : "/appointments"}>{c.appointment_service} · {fmt.dateTime(c.appointment_starts_at)}</Link> <Badge value={c.appointment_status || "booked"} /></span>
                    ) : null}
                    {c.contact_id ? <span>Customer: <Link href={`/customers/${c.contact_id}`}>{fmt.name(c.first_name, c.last_name)}</Link></span> : null}
                    {c.disconnection_reason ? <span className="muted">Ended: {label(c.disconnection_reason)}</span> : null}
                    {c.retell_call_id ? <span className="muted mono" style={{ fontSize: 11 }}>{c.retell_call_id}</span> : null}
                  </div>
                  <Recording url={c.recording_url} />
                  {c.summary ? <p className="cd-summary">{c.summary}</p> : null}
                  <CallTranscript text={c.transcript} />
                </div>
              </details>
            );
          })}
        </div>
      ) : <Empty>No calls recorded yet. Make a test call to your Retell agent to see it here.</Empty>}
    </>
  );
}
