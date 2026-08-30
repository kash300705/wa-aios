import Link from "next/link";
import { getOverview, getAnalytics, getAppointments, getCalls, connected } from "../../lib/api";
import { fmt } from "../../lib/format";
import { Card, PageHead, Stat, BarList, Badge, Empty, Distribution, AreaChart } from "../../lib/ui";

export const dynamic = "force-dynamic";

const I = {
  calls: "M4 4h5l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v5a2 2 0 0 1-2 2A17 17 0 0 1 2 6a2 2 0 0 1 2-2Z",
  calendar: "M4 5h16v16H4zM4 9h16M8 3v4M16 3v4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
  wallet: "M3 7h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11M17 13h.01"
};
const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

function pctChange(now: number, prev: number): number | null {
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}

export default async function OverviewPage() {
  const overview = await getOverview();
  const tenantName = overview.tenant.name;

  if (!connected) {
    return (
      <>
        <PageHead title="Dashboard" lede="Overview of your AI receptionist performance." />
        <Empty>Connect the live API to see your numbers.</Empty>
      </>
    );
  }

  const [analytics, upcoming, callsData] = await Promise.all([
    getAnalytics(60),
    getAppointments("upcoming"),
    getCalls()
  ]);

  // Split the 60-day window into two 30-day halves for period-over-period deltas.
  const s = analytics.series;
  const half = Math.floor(s.length / 2);
  const recent = s.slice(half);
  const prior = s.slice(0, half);
  const sumBy = (rows: typeof s, k: keyof (typeof s)[number]) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);

  const kpis = [
    { key: "Total calls", icon: I.calls, tone: "lav" as const, now: sumBy(recent, "calls"), prev: sumBy(prior, "calls"), fmt: fmt.int },
    { key: "Appointments booked", icon: I.calendar, tone: "mint" as const, now: sumBy(recent, "booked"), prev: sumBy(prior, "booked"), fmt: fmt.int },
    { key: "New leads", icon: I.user, tone: "blue" as const, now: sumBy(recent, "leads"), prev: sumBy(prior, "leads"), fmt: fmt.int },
    { key: "Revenue booked", icon: I.wallet, tone: "warm" as const, now: sumBy(recent, "revenue"), prev: sumBy(prior, "revenue"), fmt: fmt.chf }
  ];

  const trend = recent.map((p) => ({ label: p.date.slice(5), value: p.booked }));

  // Call outcomes — from the 30-day call log stats.
  const cs = callsData.stats;
  const answeredNoBooking = Math.max(0, cs.answered - cs.booked - cs.transferred);
  const missed = Math.max(0, cs.total - cs.answered);
  const outcomes = [
    { label: "Booked on the call", value: cs.booked },
    { label: "Answered, no booking", value: answeredNoBooking },
    { label: "Transferred to a person", value: cs.transferred },
    { label: "Missed / voicemail", value: missed }
  ];

  // Next appointments — upcoming bookings still on the books, soonest first.
  const now = Date.now();
  const live = upcoming
    .filter((a) => ["booked", "confirmed", "reserved"].includes(a.status) && new Date(a.starts_at).getTime() >= now - 3_600_000)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  const recentAppts = (live.length ? live : upcoming).slice(0, 5);

  // Top services — from what's on the calendar now.
  const svcMap = new Map<string, number>();
  for (const a of upcoming) if (a.service) svcMap.set(a.service, (svcMap.get(a.service) || 0) + 1);
  const topServices = [...svcMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([label, value]) => ({ label, value, hint: `${value}` }));

  return (
    <>
      <PageHead title="Dashboard" lede={`How ${tenantName}'s AI receptionist is performing — last 30 days.`} />

      <div className="grid cols-4" style={{ marginBottom: 20 }}>
        {kpis.map((k) => {
          const delta = pctChange(k.now, k.prev);
          return (
            <Stat
              key={k.key}
              k={k.key}
              v={k.fmt(k.now)}
              icon={<Icon d={k.icon} />}
              tone={k.tone}
              delta={delta === null ? undefined : { value: delta, suffix: "vs prev 30d" }}
            />
          );
        })}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 20 }}>
        <Card title="Appointments booked" sub="Per day, last 30 days">
          <AreaChart points={trend} height={190} valueFormat={(n) => fmt.int(n)} />
        </Card>
        <Card title="Call outcomes" sub="Last 30 days">
          <Distribution items={outcomes} />
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="Next appointments" action={<Link className="btn sm ghost" href="/appointments">View all</Link>}>
          {recentAppts.length ? (
            <div className="stack" style={{ gap: 2 }}>
              {recentAppts.map((a) => (
                <Link
                  key={a.id}
                  href={a.contact_id ? `/customers/${a.contact_id}` : "/appointments"}
                  className="spread"
                  style={{ padding: "12px 0", borderBottom: "1px solid var(--line-soft)" }}
                >
                  <span>
                    <div className="cell-strong">{fmt.name(a.first_name, a.last_name)}</div>
                    <div className="cell-sub">{a.service}</div>
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <div className="cell-strong">{fmt.dateTime(a.starts_at)}</div>
                    <div style={{ marginTop: 4 }}><Badge value={a.status} /></div>
                  </span>
                </Link>
              ))}
            </div>
          ) : <Empty>Nothing booked yet.</Empty>}
        </Card>

        <Card title="Top services" sub="On the calendar now">
          {topServices.length ? <BarList items={topServices} /> : <Empty>No upcoming bookings.</Empty>}
        </Card>
      </div>
    </>
  );
}
