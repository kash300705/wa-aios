#!/usr/bin/env node
// Creates or updates the Retell LLM + agent for one tenant, entirely from files in this repo.
//   node retell/provision.mjs            create (first run) or update (subsequent runs)
//   node retell/provision.mjs --dry-run  print the exact payloads, call nothing
//   node retell/provision.mjs --sync-tools   only re-point tool URLs/headers (API base URL changed)
// Env: RETELL_API_KEY, API_BASE_URL, RETELL_WEBHOOK_SECRET, optional TENANT_CONFIG_PATH,
//      RETELL_LLM_ID / RETELL_AGENT_ID (override the ids file).
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const syncOnly = args.has("--sync-tools");
const RETELL = "https://api.retellai.com";
const IDS_FILE = path.join(here, ".retell-ids.json");
const LEGACY_IDS_FILE = path.join(root, ".retell-ids.json");

export async function loadEnv(file = path.join(root, ".env")) {
  const env = { ...process.env };
  if (!existsSync(file)) return env;
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !(match[1] in process.env)) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const dayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const title = (day) => day[0].toUpperCase() + day.slice(1);

export function renderPrompt(template, tenant) {
  const staff = tenant.booking?.staff ?? [];
  // A tenant with a shared calendar does not let callers pick a stylist, so the
  // agent is given no stylist list and no staffId to pass.
  const sharedCalendar = Boolean(tenant.booking?.sharedCalendarId);
  const services = tenant.services ?? [];
  const hours = tenant.booking?.hours ?? {};
  const city = tenant.contact?.address?.split(",").pop()?.replace(/[0-9]/g, "").trim() || "Switzerland";
  let prompt = template
    .replaceAll("{{salon_name}}", tenant.salonName)
    .replaceAll("{{city}}", city)
    .replaceAll("{{default_staff_handling}}", `whichever of ${staff.map((s) => s.name).join(", ")} is free`)
    .replaceAll("{{service}}", "the service")
    .replaceAll("{{stylist}}", "the stylist")
    .replaceAll("{{day}}", "the day")
    .replaceAll("{{time}}", "the time");

  const menu = services.map((s) => `- ${s.name} — ${s.durationMinutes} min — CHF ${s.priceChf}`).join("\n");
  const stylists = staff.map((s) => `- ${s.name} (staffId: ${s.id})${s.aliases?.length ? ` — also called ${s.aliases.join(", ")}` : ""}`).join("\n");
  const openings = dayNames.map((day) => {
    const ranges = hours[day] ?? [];
    return `- ${title(day)}: ${ranges.length ? ranges.map((r) => `${r.start}–${r.end}`).join(", ") : "closed"}`;
  }).join("\n");
  const closures = [...(tenant.booking?.closureDates ?? []), ...(tenant.booking?.additionalHolidayDates ?? [])];

  prompt += `

# SERVICE MENU (authoritative — pass the exact service name as serviceId)
${menu || "- (no services configured)"}
${sharedCalendar ? "" : `
# STYLISTS (pass the id as staffId)
${stylists || "- (no stylists configured)"}
`}
# OPENING HOURS (${tenant.timezone})
${openings}
${closures.length ? `Closed on: ${closures.join(", ")}.` : ""}
Never offer a time outside these hours. check_availability enforces them and returns alternatives.
Prices are in ${tenant.currency ?? "CHF"}.
`;
  return prompt;
}

export function buildTools(template, { apiBaseUrl, webhookSecret, transferNumber }) {
  const base = apiBaseUrl.replace(/\/$/, "");
  return template.map((tool) => {
    if (tool.type === "end_call") return { type: "end_call", name: tool.name, description: tool.description };
    if (tool.type === "transfer_call") {
      return {
        type: "transfer_call",
        name: tool.name,
        description: tool.description,
        transfer_destination: { type: "predefined", number: transferNumber },
        transfer_option: { type: "cold_transfer", cold_transfer_mode: "sip_invite", show_transferee_as_caller: false },
        speak_during_execution: true,
        speak_after_execution: true,
        execution_message_type: "prompt",
        custom_sip_headers: {}
      };
    }
    const out = {
      ...tool,
      url: tool.url.replace("{{N8N_BASE_URL}}", base),
      // The API reads the tool parameters from the top level of the JSON body.
      method: tool.method ?? "POST",
      args_at_root: tool.args_at_root ?? true
    };
    if (webhookSecret) out.headers = { ...(tool.headers ?? {}), "x-retell-webhook-secret": webhookSecret };
    return out;
  });
}

export function toE164(value) {
  const digits = String(value ?? "").replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : `+${digits}`;
}

async function api(env, method, pathname, body) {
  const response = await fetch(`${RETELL}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${env.RETELL_API_KEY}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Retell ${method} ${pathname} → ${response.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function readIds(env) {
  if (env.RETELL_LLM_ID && env.RETELL_AGENT_ID) return { llm_id: env.RETELL_LLM_ID, agent_id: env.RETELL_AGENT_ID };
  for (const file of [IDS_FILE, LEGACY_IDS_FILE]) {
    if (existsSync(file)) {
      const ids = JSON.parse(await readFile(file, "utf8"));
      if (ids.llm_id && ids.agent_id) return ids;
    }
  }
  return null;
}

function redact(payload, secret) {
  const text = JSON.stringify(payload, null, 2);
  return secret ? text.replaceAll(secret, "«RETELL_WEBHOOK_SECRET»") : text;
}

export async function main() {
  const env = await loadEnv();
  const tenantPath = path.resolve(root, env.TENANT_CONFIG_PATH || "config/tenant.demo.json");
  const tenant = JSON.parse(await readFile(tenantPath, "utf8"));
  const template = JSON.parse(await readFile(path.join(here, "agent-config.json"), "utf8"));
  const promptTemplate = await readFile(path.join(here, "prompt-master.md"), "utf8");

  const apiBaseUrl = env.API_BASE_URL;
  if (!apiBaseUrl) throw new Error("API_BASE_URL is required (the public URL Retell can reach your api/ on).");
  if (!env.RETELL_WEBHOOK_SECRET) console.warn("WARN RETELL_WEBHOOK_SECRET is unset — tool calls will be sent without authentication.");
  if (!dryRun && !env.RETELL_API_KEY) throw new Error("RETELL_API_KEY is required (or pass --dry-run).");

  const transferNumber = toE164(tenant.contact?.transferPhone || tenant.contact?.phone);
  const llm = template.retellLlmData;
  const tools = buildTools(llm.general_tools, { apiBaseUrl, webhookSecret: env.RETELL_WEBHOOK_SECRET, transferNumber });
  const llmPayload = {
    model: llm.model || "gpt-5.1",
    general_prompt: renderPrompt(promptTemplate, tenant),
    general_tools: tools,
    begin_message: llm.begin_message.replaceAll("{{salon_name}}", tenant.salonName),
    start_speaker: "agent"
  };
  const agentPayload = {
    agent_name: `${tenant.salonName} — AI Receptionist`,
    voice_id: template.voice_id || "11labs-Nia",
    language: template.language || "multi",
    post_call_analysis_data: template.post_call_analysis_data ?? [],
    max_call_duration_ms: template.max_call_duration_ms ?? 600000,
    interruption_sensitivity: template.interruption_sensitivity ?? 0.9,
    // Retell POSTs call_started / call_ended / call_analyzed here. The API
    // ingests the recording URL, transcript and structured outcome.
    webhook_url: `${apiBaseUrl}/webhook/retell`,
    // Keep the recording + transcript so the dashboard can play/read them.
    data_storage_setting: template.data_storage_setting || "everything"
  };

  const ids = await readIds(env);
  if (dryRun) {
    console.log(`# mode: ${syncOnly ? "sync-tools" : ids ? "update" : "create"} (dry run)\n# tenant: ${tenant.salonName} (${tenantPath})\n# api base: ${apiBaseUrl}\n# transfer: ${transferNumber}\n`);
    console.log(syncOnly ? redact({ general_tools: tools }, env.RETELL_WEBHOOK_SECRET) : redact({ llm: llmPayload, agent: agentPayload }, env.RETELL_WEBHOOK_SECRET));
    return;
  }

  if (syncOnly) {
    if (!ids) throw new Error("--sync-tools needs an existing agent. Run without --sync-tools first.");
    const out = await api(env, "PATCH", `/update-retell-llm/${ids.llm_id}`, { general_tools: tools });
    console.log(`synced ${out.general_tools.filter((t) => t.url).length} tool URLs → ${apiBaseUrl} (llm ${ids.llm_id})`);
    return;
  }

  let result;
  if (ids) {
    await api(env, "PATCH", `/update-retell-llm/${ids.llm_id}`, llmPayload);
    await api(env, "PATCH", `/update-agent/${ids.agent_id}`, agentPayload);
    result = ids;
    console.log(`updated llm ${ids.llm_id} and agent ${ids.agent_id}`);
  } else {
    const created = await api(env, "POST", "/create-retell-llm", llmPayload);
    const agent = await api(env, "POST", "/create-agent", { ...agentPayload, response_engine: { type: "retell-llm", llm_id: created.llm_id } });
    result = { llm_id: created.llm_id, agent_id: agent.agent_id };
    console.log(`created llm ${result.llm_id} and agent ${result.agent_id}`);
  }
  await writeFile(IDS_FILE, JSON.stringify({ ...result, tenant: tenant.slug, api_base_url: apiBaseUrl }, null, 2) + "\n");
  console.log(`ids written to ${path.relative(root, IDS_FILE)} (gitignored)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`ERROR ${error.message}`); process.exit(1); });
}
