import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authRequired, isAuthenticated } from "../../lib/auth";
import { connected, getOverview, getTenants, source } from "../../lib/api";
import { switchTenant } from "../../lib/actions";
import { Nav } from "./nav";
import { ThemeToggle } from "./theme-toggle";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login");

  let tenantName = "Salon";
  let counts: Record<string, number> = {};
  try {
    const o = await getOverview();
    tenantName = o.tenant?.name || tenantName;
    counts = {
      inbox: o.live.conversations_need_human || 0,
      leads: o.live.open_leads || 0,
      appointments: o.live.today_appointments || 0,
      reactivation: o.live.active_reactivation_campaigns || 0
    };
  } catch {
    /* offline — nav still renders */
  }

  let tenants: { id: string; name: string }[] = [];
  if (connected) {
    try { tenants = (await getTenants()).tenants; } catch { /* ignore */ }
  }

  const initials = (tenantName.match(/\b[A-Za-z]/g) || ["A"]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">{initials}</span>
          <span>
            <div className="brand-name">{tenantName}</div>
            <div className="brand-sub">AI Receptionist</div>
          </span>
        </Link>

        {tenants.length > 1 ? (
          <div className="biz-switcher">
            <form action={switchTenant}>
              <select className="select" name="tenantId" defaultValue="" style={{ flex: 1 }}>
                <option value="" disabled>Switch salon…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className="btn sm" type="submit">Go</button>
            </form>
          </div>
        ) : null}

        <Nav counts={counts} />

        <div className="sidebar-foot">
          <ThemeToggle />
          <span className="pill-live">
            <span className={`dot ${source === "api" ? "live" : ""}`} />
            {source === "api" ? "Live · connected" : "Demo · snapshot"}
          </span>
          {authRequired ? (
            <form action="/api/logout" method="post"><button className="link-btn" type="submit">Sign out</button></form>
          ) : null}
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
