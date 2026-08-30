import type { ReactNode } from "react";
import { STATUS_TONE, label as lbl, fmt } from "./format";

export function PageHead({ title, lede, children }: { title: string; lede?: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {children ? <div className="page-head-actions">{children}</div> : null}
    </header>
  );
}

export function Card({ title, sub, action, children, className = "" }: { title?: string; sub?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <div className="card-h">
          <div>
            {title ? <h2>{title}</h2> : null}
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ k, v, foot, delta }: { k: ReactNode; v: ReactNode; foot?: ReactNode; delta?: { value: number; suffix?: string } }) {
  return (
    <section className="card stat">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {delta !== undefined ? (
        <span className={`delta ${delta.value >= 0 ? "up" : "down"}`}>
          {delta.value >= 0 ? "▲" : "▼"} {fmt.pct(Math.abs(delta.value), 1)}{delta.suffix ? ` ${delta.suffix}` : ""}
        </span>
      ) : null}
      {foot ? <span className="foot">{foot}</span> : null}
    </section>
  );
}

export function Badge({ value, children }: { value?: string | null; children?: ReactNode }) {
  const tone = STATUS_TONE[value ?? ""] ?? "mute";
  return <span className={`badge ${tone}`}>{children ?? lbl(value)}</span>;
}

export function Avatar({ first, last }: { first?: string | null; last?: string | null }) {
  return <span className="avatar">{fmt.initials(first, last)}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Offline({ what }: { what: string }) {
  return (
    <div className="offline">
      <strong>Live API not connected.</strong>
      <p className="muted" style={{ marginTop: 6 }}>
        {what} needs the deployed API. Set <code>AIOS_API_URL</code> and <code>DASHBOARD_API_TOKEN</code> in the dashboard environment.
      </p>
    </div>
  );
}

export function BarList({ items }: { items: { label: string; value: number; hint?: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="barlist">
      {items.map((i) => (
        <div className="b" key={i.label}>
          <span className="trunc">{i.label}</span>
          <span className="track"><span className="fill" style={{ width: `${Math.max(3, (i.value / max) * 100)}%` }} /></span>
          <b className="mono">{i.hint ?? fmt.int(i.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Simple area+line chart from a numeric series. */
export function AreaChart({ points, height = 150, valueFormat = (n: number) => String(n) }: { points: { label: string; value: number }[]; height?: number; valueFormat?: (n: number) => string }) {
  if (!points.length) return <div className="empty">No data yet.</div>;
  const w = 720;
  const pad = { l: 6, r: 6, t: 10, b: 18 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = (w - pad.l - pad.r) / Math.max(1, points.length - 1);
  const y = (v: number) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const coords = points.map((p, i) => [pad.l + i * step, y(p.value)] as const);
  const line = coords.map(([x, yy], i) => `${i ? "L" : "M"}${x.toFixed(1)},${yy.toFixed(1)}`).join(" ");
  const area = `${line} L${coords.at(-1)![0].toFixed(1)},${height - pad.b} L${coords[0][0].toFixed(1)},${height - pad.b} Z`;
  const ticks = points.length > 8 ? points.filter((_, i) => i % Math.ceil(points.length / 6) === 0) : points;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="trend">
      <defs>
        <linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--brand)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} className="grid-line" x1={pad.l} x2={w - pad.r} y1={pad.t + f * (height - pad.t - pad.b)} y2={pad.t + f * (height - pad.t - pad.b)} />
      ))}
      <path className="area" d={area} />
      <path className="line" d={line} />
      {coords.map(([x, yy], i) => (i === coords.length - 1 ? <circle key={i} cx={x} cy={yy} r="3" fill="var(--brand)" /> : null))}
      {ticks.map((p) => {
        const i = points.indexOf(p);
        return <text key={p.label + i} className="axis" x={pad.l + i * step} y={height - 4} textAnchor="middle">{p.label}</text>;
      })}
      <text className="axis" x={pad.l} y={pad.t + 2}>{valueFormat(max)}</text>
    </svg>
  );
}

/** Grouped mini bar chart (e.g. bookings vs completed per day). */
export function MiniBars({ series, keys, height = 150 }: { series: Record<string, number>[]; keys: { name: string; color: string }[]; height?: number }) {
  if (!series.length) return <div className="empty">No data yet.</div>;
  const w = 720;
  const pad = { l: 6, r: 6, t: 8, b: 4 };
  const max = Math.max(1, ...series.flatMap((s) => keys.map((k) => Number(s[k.name] || 0))));
  const groupW = (w - pad.l - pad.r) / series.length;
  const barW = Math.max(1.5, Math.min(10, (groupW - 3) / keys.length));
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="bars">
      {series.map((s, gi) =>
        keys.map((k, ki) => {
          const v = Number(s[k.name] || 0);
          const h = (v / max) * (height - pad.t - pad.b);
          return <rect key={`${gi}-${ki}`} x={pad.l + gi * groupW + ki * (barW + 1)} y={height - pad.b - h} width={barW} height={Math.max(0, h)} rx="1.5" fill={k.color} opacity="0.9" />;
        })
      )}
    </svg>
  );
}

/** Inline audio player for a call recording, with a fallback link. */
export function Recording({ url }: { url?: string | null }) {
  if (!url) return <span className="muted">No recording</span>;
  return (
    <div className="recording">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio controls preload="none" src={url} className="recording-audio" />
      <a className="btn sm ghost" href={url} target="_blank" rel="noreferrer">Open ↗</a>
    </div>
  );
}

/** Render a Retell "Agent: … / User: …" transcript as a readable conversation. */
export function CallTranscript({ text }: { text?: string | null }) {
  if (!text || text === "[Demo transcript omitted]") {
    return <div className="muted" style={{ fontSize: 13 }}>No transcript for this call.</div>;
  }
  const lines = text.split("\n");
  const turns: { who: "agent" | "user" | "system"; text: string }[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = /^(Agent|User|Assistant|Bot|Caller|Customer)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const who = /agent|assistant|bot/i.test(m[1]) ? "agent" : "user";
      turns.push({ who, text: m[2] });
    } else if (turns.length) {
      turns[turns.length - 1].text += (turns[turns.length - 1].text ? " " : "") + line;
    } else {
      turns.push({ who: "system", text: line });
    }
  }
  return (
    <div className="transcript">
      {turns.map((t, i) => (
        <div key={i} className={`t-turn t-${t.who}`}>
          <span className="t-who">{t.who === "agent" ? "AI" : t.who === "user" ? "Caller" : "•"}</span>
          <span className="t-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function DataTable<T>({ columns, rows, empty = "Nothing here yet.", rowKey }: {
  columns: { key: string; label: string; num?: boolean; render: (row: T) => ReactNode }[];
  rows: T[];
  empty?: string;
  rowKey: (row: T) => string;
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.num ? "num" : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => <td key={c.key} className={c.num ? "num" : undefined}>{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
