const TZ = "Europe/Zurich";

const dtf = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ });
const df = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: TZ });
const tf = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });

export const fmt = {
  dateTime: (v?: string | null) => (v ? dtf.format(new Date(v)) : "—"),
  date: (v?: string | null) => (v ? df.format(new Date(v)) : "—"),
  time: (v?: string | null) => (v ? tf.format(new Date(v)) : "—"),
  int: (v: number) => new Intl.NumberFormat("en-GB").format(Math.round(v || 0)),
  chf: (v: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "CHF", maximumFractionDigits: 0 }).format(v || 0),
  pct: (v: number, digits = 0) => `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(v || 0)}%`,
  dur: (s: number) => {
    if (!s) return "—";
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  },
  name: (first?: string | null, last?: string | null) => [first, last].filter(Boolean).join(" ") || "Unknown",
  initials: (first?: string | null, last?: string | null) =>
    ([first, last].filter(Boolean).map((s) => s![0]).join("") || "?").slice(0, 2).toUpperCase(),
  rel: (v?: string | null) => {
    if (!v) return "—";
    const diff = Date.now() - new Date(v).getTime();
    const abs = Math.abs(diff);
    const units: [number, string][] = [[86400000 * 365, "y"], [86400000 * 30, "mo"], [86400000 * 7, "w"], [86400000, "d"], [3600000, "h"], [60000, "m"]];
    for (const [ms, label] of units) if (abs >= ms) return `${diff < 0 ? "in " : ""}${Math.round(abs / ms)}${label}${diff < 0 ? "" : " ago"}`;
    return "just now";
  }
};

export const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "Email", instagram: "Instagram", call: "Phone", google: "Google", website: "Website", manual: "Manual" };

export const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "info" | "mute"> = {
  booked: "info", completed: "ok", reserved: "info", no_show: "bad", cancelled: "mute",
  new: "info", contacted: "info", qualified: "ok", lost: "mute",
  sent: "ok", delivered: "ok", queued: "info", failed: "bad", stubbed: "mute", received: "info", dropped_quiet_hours: "mute",
  active: "ok", paused: "warn", draft: "mute", archived: "mute",
  ai_handling: "info", human_needed: "warn", open: "info", closed: "mute",
  pending: "mute", responded: "ok", opted_out: "bad", skipped: "mute",
  now: "bad", this_week: "warn", flexible: "mute",
  answered: "ok", missed: "bad", transferred: "warn", inquiry: "info", complaint: "bad", callback: "warn", voicemail: "warn",
  Positive: "ok", Negative: "bad", Neutral: "mute", vip: "ok", inactive: "warn", lead: "mute",
  connected: "ok", not_configured: "warn", error: "bad", unknown: "mute"
};

export const LABELS: Record<string, string> = {
  no_show: "No-show", ai_handling: "AI handling", human_needed: "Needs human",
  dropped_quiet_hours: "Quiet hours", opted_out: "Opted out", this_week: "This week",
  lead_follow_up: "Lead follow-up", re_engagement: "Re-engagement", reactivation: "Reactivation",
  appointment_reminder: "Appt reminder", no_show_recovery: "No-show recovery", review_request: "Review request",
  appointment_confirmation: "Confirmation", appointment_completion: "Thank-you",
  appointment_rescheduled: "Reschedule", appointment_cancelled: "Cancellation",
  missed_call: "Missed-call follow-up", lead_followup: "Lead follow-up",
  appointment_t_24h: "24h reminder", appointment_t_2h: "2h reminder", appointment_t_48h: "48h reminder",
  not_configured: "Not configured"
};

export const label = (v?: string | null) => (v ? LABELS[v] || v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—");
