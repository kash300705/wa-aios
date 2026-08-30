import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import type { KpiDay, Tenant } from "./types";

const RAW_API = (process.env.AIOS_API_URL || "").replace(/\/$/, "");
const TOKEN = process.env.DASHBOARD_API_TOKEN || "";
const DEFAULT_TENANT = process.env.NEXT_PUBLIC_DEMO_TENANT_ID || "";
export const connected = Boolean(RAW_API && TOKEN);
export const source: "api" | "snapshot" = connected ? "api" : "snapshot";
export const TENANT_COOKIE = "wa_tenant";

async function activeTenant(): Promise<string> {
  try {
    const store = await cookies();
    return store.get(TENANT_COOKIE)?.value || DEFAULT_TENANT;
  } catch {
    return DEFAULT_TENANT;
  }
}

class OfflineError extends Error {
  constructor(what: string) {
    super(`This view needs the live API. Set AIOS_API_URL and DASHBOARD_API_TOKEN (${what}).`);
  }
}

async function apiGet<T>(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!connected) throw new OfflineError(pathname);
  const url = new URL(`${RAW_API}/api/dashboard/${pathname}`);
  const tenant = await activeTenant();
  if (tenant) url.searchParams.set("tenantId", tenant);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`AIOS API ${pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
  if (!connected) throw new OfflineError(pathname);
  const tenant = await activeTenant();
  const res = await fetch(`${RAW_API}/api/dashboard/${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, tenantId: tenant || undefined }),
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`AIOS API ${pathname} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

// ---- snapshot fallback (legacy pages only) --------------------------------
type Snapshot = {
  generatedAt: string; tenant: Tenant; kpis: KpiDay[]; live: Live;
  appointments: { upcoming: Appointment[]; past: Appointment[] };
  calls: Call[]; leads: Lead[]; funnel: Funnel; reviews: unknown[]; complaints: unknown[]; messages: unknown[];
};
let snapshotCache: Promise<Snapshot> | null = null;
function snapshot(): Promise<Snapshot> {
  snapshotCache ??= readFile(path.join(process.cwd(), "data", "seed-dashboard.json"), "utf8")
    .then((raw) => JSON.parse(raw) as Snapshot)
    .catch(() => ({
      generatedAt: new Date().toISOString(),
      tenant: { id: DEFAULT_TENANT, slug: "demo", name: "Demo Salon", locale: "de-CH", timezone: "Europe/Zurich", currency: "CHF", branding: {}, contact_config: {}, avg_appointment_value_chf: 120, baseline_no_show_rate: 0.12 },
      kpis: [], live: { upcoming_appointments: 0, today_appointments: 0, open_leads: 0, open_complaints: 0, queued_messages: 0, calls_7d: 0 },
      appointments: { upcoming: [], past: [] }, calls: [], leads: [], funnel: [], reviews: [], complaints: [], messages: []
    } as Snapshot));
  return snapshotCache;
}

// ---- types ---------------------------------------------------------------
export type Live = {
  upcoming_appointments: number; today_appointments: number; open_leads: number; open_complaints: number;
  queued_messages: number; calls_7d: number; conversations_need_human?: number; total_customers?: number;
  active_reactivation_campaigns?: number; upcoming_revenue_chf?: number;
};
export type ActivityRow = { event_type: string; aggregate_type: string; occurred_at: string; payload: Record<string, unknown>; first_name: string; last_name: string };
export type Appointment = { id: string; status: string; status_source: string; starts_at: string; ends_at: string; service: string; value_chf: number; staff: string; lead_source: string | null; booked_via?: string | null; recovered_from_no_show_id: string | null; contact_id?: string; first_name: string; last_name: string | null; phone_e164: string | null; email: string | null };
export type Call = { id: string; retell_call_id: string; started_at: string; ended_at?: string | null; duration_seconds: number; answered: boolean; outcome: string | null; direction?: string; disclosure_played: boolean; transcript: string | null; recording_url: string | null; summary?: string | null; sentiment?: string | null; user_sentiment?: string | null; from_number?: string | null; to_number?: string | null; call_successful?: boolean | null; in_voicemail?: boolean | null; cost_cents?: number | null; contact_id?: string | null; appointment_id?: string | null; first_name: string | null; last_name?: string | null; phone_e164: string | null; appointment_service?: string | null; appointment_starts_at?: string | null; appointment_status?: string | null; disconnection_reason?: string | null };
export type CallStats = { total: number; answered: number; booked: number; transferred: number; with_transcript: number; avg_duration: number };
export type Lead = { id: string; source: string; channel: string | null; service_interest: string | null; urgency: string; preferred_time: string | null; notes: string | null; status: string; booked_appointment_id: string | null; created_at: string; updated_at: string; contact_id: string; first_name: string; last_name: string | null; phone_e164: string | null; email: string | null; manychat_subscriber_id: string | null; follow_ups_sent: number; next_follow_up_at: string | null };
export type Funnel = { status: string; count: number }[];
export type Customer = { id: string; first_name: string; last_name: string | null; email: string | null; phone_e164: string | null; manychat_subscriber_id: string | null; lifecycle_stage: string; last_interaction_at: string | null; last_interaction_kind: string | null; last_booked_at: string | null; first_booked_at: string | null; total_bookings: number; completed_bookings: number; no_show_count: number; lifetime_value_chf: number; tags: string[]; marketing_opt_out: boolean; source: string; created_at: string; lead_status: string | null; upcoming: number };
export type Segment = { lifecycle_stage: string; count: number };
export type Conversation = { id: string; channel: string; status: string; ai_enabled: boolean; last_message_at: string | null; last_direction: string | null; unread_count: number; contact_id: string; first_name: string; last_name: string | null; phone_e164: string | null; email: string | null; last_body?: string | null };
export type ConversationMessage = { id: string; channel?: string; direction: string; body: string; template_id: string | null; ai_generated: boolean; delivery_status: string; created_at: string; sent_at: string | null; scheduled_for: string | null };
export type SequenceRun = { id: string; sequence_type: string; current_step: string; status: string; next_fire_at: string | null; started_at: string; exit_reason?: string | null; contact_id: string; first_name: string; last_name: string | null; phone_e164: string | null; email: string | null };
export type QueuedMessage = { id: string; channel: string; template_id: string | null; body: string; scheduled_for: string; contact_id: string; first_name: string; last_name: string | null };
export type Campaign = { id: string; name: string; status: string; channel: string; criteria: Record<string, unknown>; offer: string | null; goal: string | null; message_style: string; daily_send_cap: number; total_targeted: number; messages_sent: number; responses: number; bookings: number; launched_at: string | null; completed_at: string | null; created_at: string; updated_at: string };
export type CampaignTarget = { id: string; status: string; personalised_body: string | null; scheduled_for: string | null; sent_at: string | null; responded_at: string | null; booked_appointment_id: string | null; first_name: string; last_name: string | null; email: string | null; phone_e164: string | null };
export type AnalyticsPoint = { date: string; booked: number; completed: number; no_shows: number; calls: number; leads: number; revenue: number };

// ---- fetchers ----------------------------------------------------------
function normalizeKpi(row: Record<string, unknown>): KpiDay {
  const out = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) if (k !== "kpi_date" && k !== "average_rating") out[k] = Number(v || 0);
  out.average_rating = row.average_rating == null ? null : Number(row.average_rating);
  out.kpi_date = String(row.kpi_date).slice(0, 10);
  return out as KpiDay;
}

export async function getOverview() {
  if (connected) {
    const o = await apiGet<{ tenant: Tenant; kpis: Record<string, unknown>[]; live: Live; activity: ActivityRow[]; generatedAt: string }>("overview");
    return { source, tenant: o.tenant, kpis: (o.kpis || []).map(normalizeKpi), live: o.live, activity: o.activity || [], generatedAt: o.generatedAt };
  }
  const s = await snapshot();
  return { source, tenant: s.tenant, kpis: (s.kpis || []).map((k) => normalizeKpi(k as unknown as Record<string, unknown>)), live: s.live, activity: [] as ActivityRow[], generatedAt: s.generatedAt };
}
export async function getTenant(): Promise<Tenant> { return (await getOverview()).tenant; }

export async function getAppointments(scope: "upcoming" | "past") {
  if (connected) return (await apiGet<{ appointments: Appointment[] }>("appointments", { scope: scope === "past" ? "past" : undefined, limit: 300 })).appointments;
  return (await snapshot()).appointments[scope];
}
export async function getCalls() {
  if (connected) return apiGet<{ calls: Call[]; stats: CallStats }>("calls", { limit: 200 });
  return { calls: (await snapshot()).calls, stats: { total: 0, answered: 0, booked: 0, transferred: 0, with_transcript: 0, avg_duration: 0 } };
}
export const getCall = (id: string) => apiGet<{ call: Record<string, unknown>; error?: string }>("call", { id });
export async function getLeads(status?: string) {
  if (connected) return apiGet<{ leads: Lead[]; funnel: Funnel }>("leads", { status, limit: 300 });
  const s = await snapshot();
  return { leads: status ? s.leads.filter((l) => l.status === status) : s.leads, funnel: s.funnel };
}
export const getCustomers = (params: { stage?: string; q?: string } = {}) => apiGet<{ customers: Customer[]; segments: Segment[] }>("customers", { ...params, limit: 300 });
export type CustomerCall = { id: string; retell_call_id: string; started_at: string; ended_at: string | null; duration_seconds: number; outcome: string | null; direction: string; answered: boolean; summary: string | null; recording_url: string | null; transcript: string | null; sentiment: string | null; user_sentiment: string | null; disclosure_played: boolean; from_number: string | null; appointment_id: string | null };
export type EmailEvent = {
  id: string; email_type: string; recipient: string | null; subject: string | null;
  status: string; provider_message_id: string | null; error: string | null;
  scheduled_for: string | null; sent_at: string | null; created_at: string;
  appointment_id: string | null; call_id: string | null; lead_id: string | null;
};
export const getCustomer = (id: string) => apiGet<{ contact: Record<string, unknown>; appointments: Appointment[]; calls: CustomerCall[]; messages: ConversationMessage[]; notes: { id: string; author: string; kind: string; body: string; pinned: boolean; metadata: Record<string, unknown>; created_at: string }[]; leads: Lead[]; sequences: SequenceRun[]; emailActivity: EmailEvent[]; error?: string }>("customer", { id });
export const getConversations = (status?: string) => apiGet<{ conversations: Conversation[] }>("conversations", { status });
export const getConversation = (id: string) => apiGet<{ conversation: Conversation & { lifecycle_stage: string; total_bookings: number }; messages: ConversationMessage[]; error?: string }>("conversation", { id });
export const getFollowups = () => apiGet<{ active: SequenceRun[]; upcoming: QueuedMessage[]; summary: { sequence_type: string; active: number; completed: number; exited: number }[]; outbound30: { delivery_status: string; count: number }[] }>("followups");
export const getReactivation = () => apiGet<{ campaigns: Campaign[] }>("reactivation");
export const getCampaign = (id: string) => apiGet<{ campaign: Campaign; targets: CampaignTarget[]; error?: string }>("reactivation-campaign", { id });
export const getAnalytics = (days = 90) => apiGet<{ days: number; series: AnalyticsPoint[]; bySource: { source: string; leads: number; booked: number }[]; totals: Record<string, number> }>("analytics", { days });
export type EmailAutomation = {
  status: "connected" | "not_configured" | "error" | "unknown";
  detail?: string; provider: string; from: string | null; replyTo: string | null;
  apiKeyPresent?: boolean;
  recent?: { failed: number; sent: number; queued: number; total: number };
};
export const getSettings = () => apiGet<{ tenant: Record<string, unknown>; emailAutomation?: EmailAutomation }>("settings");
export const getTenants = () => apiGet<{ tenants: { id: string; slug: string; name: string; locale: string; timezone: string; upcoming: number }[] }>("tenants");
