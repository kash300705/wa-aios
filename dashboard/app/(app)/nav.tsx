"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS: Record<string, string> = {
  overview: "M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-12h8V3h-8v6Z",
  inbox: "M4 4h16v12H8l-4 4V4Z",
  calls: "M4 4h5l2 5-3 2a12 12 0 0 0 5 5l2-3 5 2v5a2 2 0 0 1-2 2A17 17 0 0 1 2 6a2 2 0 0 1 2-2Z",
  customers: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
  leads: "M3 6h18M3 12h18M3 18h12",
  appointments: "M4 5h16v16H4zM4 9h16M8 3v4M16 3v4",
  followups: "M12 8v4l3 2M21 12a9 9 0 1 1-3-6.7",
  reactivation: "M4 12a8 8 0 1 1 2.3 5.6M4 20v-5h5",
  analytics: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4 12l-1.5 2 1 2M20 12l1.5 2-1 2M12 4V2M12 22v-2"
};

type Item = readonly [key: string, href: string, label: string];

const GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Workspace",
    items: [
      ["overview", "/", "Dashboard"],
      ["inbox", "/inbox", "Inbox"],
      ["calls", "/calls", "Calls"]
    ]
  },
  {
    label: "Clients",
    items: [
      ["customers", "/customers", "Customers"],
      ["leads", "/leads", "Leads"],
      ["appointments", "/appointments", "Appointments"]
    ]
  },
  {
    label: "Growth",
    items: [
      ["followups", "/followups", "Follow-ups"],
      ["reactivation", "/reactivation", "Reactivation"],
      ["analytics", "/analytics", "Analytics"]
    ]
  },
  {
    label: "Configure",
    items: [["settings", "/settings", "Settings"]]
  }
];

export function Nav({ counts }: { counts: Record<string, number> }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      {GROUPS.map((group) => (
        <div className="nav-group" key={group.label}>
          <div className="nav-group-label">{group.label}</div>
          {group.items.map(([key, href, labelText]) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            const count = counts[key];
            return (
              <Link key={href} href={href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={ICONS[key]} />
                </svg>
                {labelText}
                {count ? <span className={`count ${key === "inbox" ? "alert" : ""}`}>{count}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
