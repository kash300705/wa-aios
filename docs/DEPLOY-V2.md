# Deploying the v2 system (CRM, AI conversations, reactivation, premium dashboard)

Everything is code-complete on branch **`feat/crm-ai-reactivation-dashboard`**.
36 API tests pass; the dashboard builds clean. This is what remains — all of it is
entering credentials in dashboards you own.

## 1. Merge / deploy the API (Render — `wa-aios-api`)

The branch adds an incremental-migration runner. `npm run migrate` now applies
`db/migrations/*.sql` on top of the existing schema on every deploy (idempotent).

Add these environment variables on the Render service (Environment tab), then
**Manual Deploy → Deploy latest commit**:

| Key | Value | Needed for |
|---|---|---|
| `RESEND_API_KEY` | `re_…` from resend.com | Real customer email |
| `MAIL_FROM` | `Atelier Nova <hello@your-verified-domain>` | Real customer email |
| `MESSAGE_TRANSPORT_EMAIL` | `resend` | already in render.yaml |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | AI inbound replies + reactivation copy |
| `RETELL_API_KEY` | the Retell key with the **"Webhook" badge** | Verifying `X-Retell-Signature` on `/webhook/retell` — **without this the webhook 401s** |

Without `ANTHROPIC_API_KEY` the system still runs — inbound threads just route to a
human and reactivation uses templates. Without Resend, messages are generated and
shown in the dashboard as "stubbed".

`render.yaml` already declares all of the above (`sync:false`), plus optional
`DASHBOARD_TENANT_IDS` (comma-separated tenant UUIDs) if you ever run more than one
salon from one deployment.

After deploy, check the logs for `incremental_migrations_complete` with
`applied: ["001_…","002_…","003_…"]`, and `GET /health` → `status: ok`.

## 2. Point Retell at the call webhook

`retell/provision.mjs` now sets `webhook_url` = `<API_BASE_URL>/webhook/retell` and
`data_storage_setting: everything` on the agent. Re-provision:

```bash
npm run retell:provision
```

(Or set the webhook URL manually in the Retell dashboard → your agent → Webhook URL
= `https://wa-aios-api.onrender.com/webhook/retell`.)

**Check what's live:** `GET https://wa-aios-api.onrender.com/health` now returns
`retellWebhookAuth` (`signature (RETELL_API_KEY)` once the key is set) and `commit`
(the deployed git SHA — Render sets `RENDER_GIT_COMMIT`). `GET /webhook/retell`
returns a readiness probe. A failed webhook now returns the reason in the **response
body**, not just the log: `{ "reason": "digest mismatch" | "RETELL_API_KEY is not
set" | "timestamp outside the 5-minute window" | ... }`.

**Temporary unblock:** set `RETELL_WEBHOOK_VERIFY=false` to accept unverified Retell
webhooks (logged as `retell_webhook_auth_skipped`) while sorting a key issue. Remove
it once the signature verifies.

**Signature auth.** Retell signs each webhook call with `X-Retell-Signature`
(`v=<timestamp>,d=<hmac>`, verified against your Retell API key over the raw body,
±5-minute replay window). The API verifies this exactly as `retell-sdk`'s
`Retell.verify` does. You must set **`RETELL_API_KEY`** on Render to the key that
shows the **"Webhook" badge** in the Retell dashboard (API Keys page). If it's
missing or wrong, `/webhook/retell` returns 401 and the Render log line
`retell_webhook_auth_failed` shows the reason (`RETELL_API_KEY is not set` /
`digest mismatch` / `timestamp outside the 5-minute window`).

After the next real call you'll see it on the dashboard **Calls** page with the
recording, transcript and outcome; an unbooked enquiry also becomes a lead with the
follow-up ladder.

## 3. Deploy the dashboard  — DONE

**Live: https://wa-aios-dashboard.onrender.com** (Render service `wa-aios-dashboard`,
Blueprint-managed, free plan). Login password is `DASHBOARD_PASSWORD` on that
service. `AIOS_API_URL` + `DASHBOARD_API_TOKEN` (auto-wired from `wa-aios-api`) are
set. `GET /api/health` → `{ "apiConfigured": true }`.

The dashboard is a **separate service** — it is not served by the API.
`GET https://wa-aios-api.onrender.com/` returning `not_found` is expected; that
host is the API only. If you ever need to recreate it, pick one of:

Env vars (all three deploy targets need these):

| Key | Value |
|---|---|
| `AIOS_API_URL` | `https://wa-aios-api.onrender.com` |
| `DASHBOARD_API_TOKEN` | Render → `wa-aios-api` → Environment → `DASHBOARD_API_TOKEN` → **Reveal**, copy the value |
| `NEXT_PUBLIC_DEMO_TENANT_ID` | `11111111-1111-4111-8111-111111111111` |
| `DASHBOARD_PASSWORD` | a login password for the salon owner |

### Option A — Vercel (recommended for Next.js: free, no cold starts)

1. vercel.com → **Add New… → Project** → import `kash300705/wa-aios`.
2. **Root Directory: `dashboard`** (Vercel auto-detects Next.js; `dashboard/vercel.json` pins the install command).
3. Add the four env vars above → **Deploy**.
4. URL: `https://<project>.vercel.app`.

### Option B — Render Blueprint (everything in one place)

`render.yaml` (repo root) now declares **`wa-aios-dashboard`** alongside the API.
`DASHBOARD_API_TOKEN` is wired from the API service automatically (`fromService`).

- If `wa-aios-api` is already on a Blueprint: Render → your Blueprint → **Sync** →
  approve creating `wa-aios-dashboard`. Set `DASHBOARD_PASSWORD` on the new service.
- If `wa-aios-api` was created manually (no root `render.yaml` existed before), use
  Option A, or Option C.
- URL: `https://wa-aios-dashboard.onrender.com`. It is on the **free** plan
  (sleeps after 15 min idle); change `plan: free` → `starter` in `render.yaml`
  for always-on.

### Option C — Render, standalone service (no Blueprint)

Render → **New → Web Service** → connect `kash300705/wa-aios`:
- Root Directory: `dashboard`
- Build: `npm ci --include=dev && npm run build`
- Start: `npm run start -- -p $PORT`
- Health Check Path: `/api/health`
- Add the four env vars above.

---

The dashboard is the 10-section product: Overview, Inbox, Calls, Customers (+ 360),
Leads, Appointments, Follow-ups, Reactivation, Analytics, Settings. Verify with
`GET <dashboard-url>/api/health` → `{ "apiConfigured": true }`.

## 4. What each new piece does

- **Retell call webhook** (`/webhook/retell`) — recording URL, full transcript,
  structured outcome, sentiment; links/creates the caller as a contact; unbooked
  enquiry → lead + follow-up ladder.
- **Inbound AI** (`/webhook/inbound-message`) — any inbound WhatsApp/SMS/email/IG
  message stops the running follow-up or reactivation sequence immediately, then
  the AI answers, checks availability and can book. Complaints / off-menu → human.
- **Follow-up ladder** — immediate / 10 min / 2 h / next day / 3 days, stops on
  reply or booking.
- **Appointment automation** — immediate confirmation, T-48h/24h/2h reminders,
  post-visit completion message, then the review request.
- **Reactivation** — pick a lapsed segment ("no booking in 90 days, 1+ past
  visits"), preview it, launch; the AI writes each opener, sends are drip-capped,
  a reply hands off to the AI conversation and stops the campaign for that person.
- **CRM** — every contact is a customer record with lifecycle stage, lifetime
  value, visit history, full timeline (calls + messages + notes + appointments),
  and staff notes.

## 5. Migrations already written

- `001_crm_conversations_reactivation.sql` — new columns + tables + RLS
- `002_backfill_contact_rollups.sql` — populates lifetime value / lifecycle from history
- `003_demo_lapsed_customers.sql` — **demo tenant only**: 34 lapsed customers so
  reactivation has a realistic audience in sales demos (hard-scoped to the demo UUID)
