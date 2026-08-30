"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { apiPost } from "./api";
import { TENANT_COOKIE } from "./api";

async function post(path: string, body: Record<string, unknown>) {
  return apiPost<Record<string, unknown>>(path, body);
}

export async function createNote(formData: FormData) {
  const contactId = String(formData.get("contactId") || "");
  const body = String(formData.get("body") || "").trim();
  if (!contactId || !body) return;
  await post("notes", { contactId, body, kind: String(formData.get("kind") || "note"), pinned: formData.get("pinned") === "on" });
  revalidatePath(`/customers/${contactId}`);
}

export async function setLeadStatus(formData: FormData) {
  const leadId = String(formData.get("leadId") || "");
  const status = String(formData.get("status") || "");
  if (!leadId || !status) return;
  await post("lead-status", { leadId, status, notes: formData.get("notes") ? String(formData.get("notes")) : undefined });
  revalidatePath("/leads");
  revalidatePath("/");
}

export async function setAppointmentOutcome(formData: FormData) {
  const appointmentId = String(formData.get("appointmentId") || "");
  const outcome = String(formData.get("outcome") || "");
  if (!appointmentId || !outcome) return;
  await post("appointment-outcome", { appointmentId, outcome, by: "dashboard" });
  revalidatePath("/appointments");
  revalidatePath("/");
}

export async function replyToConversation(formData: FormData) {
  const conversationId = String(formData.get("conversationId") || "");
  const body = String(formData.get("body") || "").trim();
  if (!conversationId || !body) return;
  await post("conversation-reply", { conversationId, body });
  revalidatePath("/inbox");
}

export async function updateConversation(formData: FormData) {
  const conversationId = String(formData.get("conversationId") || "");
  const payload: Record<string, unknown> = { conversationId };
  if (formData.get("status")) payload.status = String(formData.get("status"));
  if (formData.get("aiEnabled") !== null) payload.aiEnabled = formData.get("aiEnabled") === "true";
  await post("conversation-update", payload);
  revalidatePath("/inbox");
}

export async function updateCustomer(formData: FormData) {
  const contactId = String(formData.get("contactId") || "");
  if (!contactId) return;
  const payload: Record<string, unknown> = { contactId };
  if (formData.get("lifecycleStage")) payload.lifecycleStage = String(formData.get("lifecycleStage"));
  if (formData.get("marketingOptOut") !== null) payload.marketingOptOut = formData.get("marketingOptOut") === "on";
  await post("customer-update", payload);
  revalidatePath(`/customers/${contactId}`);
  revalidatePath("/customers");
}

export async function updateSettings(formData: FormData) {
  const payload: Record<string, unknown> = {};
  const name = formData.get("name");
  if (name) payload.name = String(name);
  const avg = formData.get("avgAppointmentValueChf");
  if (avg) payload.avgAppointmentValueChf = Number(avg);
  const qs = formData.get("quietStart");
  const qe = formData.get("quietEnd");
  if (qs && qe) payload.quietHours = { start: String(qs), end: String(qe) };
  const contact: Record<string, unknown> = {};
  for (const key of ["phone", "email", "address", "transferPhone"]) {
    const v = formData.get(`contact_${key}`);
    if (v !== null) contact[key] = String(v);
  }
  if (Object.keys(contact).length) payload.contact = contact;
  const review: Record<string, unknown> = {};
  for (const key of ["googleReviewUrl", "ownerAlertEmail"]) {
    const v = formData.get(`review_${key}`);
    if (v !== null) review[key] = String(v);
  }
  if (Object.keys(review).length) payload.review = review;
  const booking = formData.get("bookingSharedCalendarId");
  if (booking) payload.booking = { sharedCalendarId: String(booking) };
  await post("settings-update", payload);
  revalidatePath("/settings");
}

export async function updateEmailAutomation(formData: FormData) {
  const keys = ["confirmation", "reminder24h", "reminder2h", "rescheduled", "cancelled", "missedCall", "leadFollowup", "completion"];
  const emailAutomation: Record<string, unknown> = {};
  for (const k of keys) emailAutomation[k] = formData.get(`email_${k}`) === "on";
  const delay = formData.get("leadFollowupDelayMinutes");
  if (delay) emailAutomation.leadFollowupDelayMinutes = Number(delay);
  for (const k of ["from", "replyTo", "senderName"]) {
    const v = formData.get(k);
    if (v !== null) emailAutomation[k] = String(v).trim();
  }
  await post("settings-update", { emailAutomation });
  revalidatePath("/settings");
}

export async function createCampaign(formData: FormData) {
  const body = {
    name: String(formData.get("name") || "Untitled campaign"),
    channel: String(formData.get("channel") || "email"),
    offer: formData.get("offer") ? String(formData.get("offer")) : undefined,
    goal: formData.get("goal") ? String(formData.get("goal")) : undefined,
    messageStyle: String(formData.get("messageStyle") || "warm"),
    dailySendCap: Number(formData.get("dailySendCap") || 40),
    criteria: {
      inactiveDays: Number(formData.get("inactiveDays") || 90),
      minCompletedBookings: Number(formData.get("minCompletedBookings") || 1),
      service: formData.get("service") ? String(formData.get("service")) : undefined,
      minLifetimeValueChf: formData.get("minLifetimeValueChf") ? Number(formData.get("minLifetimeValueChf")) : undefined
    }
  };
  const res = await post("reactivation-create", body) as { campaignId?: string };
  revalidatePath("/reactivation");
  return res.campaignId ? { ok: true, campaignId: res.campaignId } : { ok: false };
}

export async function launchCampaign(formData: FormData) {
  const campaignId = String(formData.get("campaignId") || "");
  if (!campaignId) return;
  await post("reactivation-launch", { campaignId });
  revalidatePath("/reactivation");
  revalidatePath(`/reactivation/${campaignId}`);
}

export async function setCampaignStatus(formData: FormData) {
  const campaignId = String(formData.get("campaignId") || "");
  const status = String(formData.get("status") || "");
  if (!campaignId || !status) return;
  await post("reactivation-status", { campaignId, status });
  revalidatePath("/reactivation");
  revalidatePath(`/reactivation/${campaignId}`);
}

export async function previewSegment(_prev: unknown, formData: FormData) {
  const criteria = {
    inactiveDays: Number(formData.get("inactiveDays") || 90),
    minCompletedBookings: Number(formData.get("minCompletedBookings") || 1),
    service: formData.get("service") ? String(formData.get("service")) : undefined,
    minLifetimeValueChf: formData.get("minLifetimeValueChf") ? Number(formData.get("minLifetimeValueChf")) : undefined
  };
  const res = await apiPost<{ total: number; estimatedValueChf: number; sample: { name: string; lastService: string | null; lastBookedAt: string | null; lifetimeValueChf: number; reachableBy: string }[] }>("reactivation-preview", { criteria });
  return { ...res, criteria };
}

export async function switchTenant(formData: FormData) {
  const tenantId = String(formData.get("tenantId") || "");
  const store = await cookies();
  if (tenantId) store.set(TENANT_COOKIE, tenantId, { path: "/", maxAge: 60 * 60 * 24 * 90, sameSite: "lax" });
  revalidatePath("/", "layout");
}
