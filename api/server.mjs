import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase, DEFAULT_TENANT_ID } from "./src/database.mjs";
import { createCalendar } from "./src/calendar.mjs";
import { BookingService, tenantIdFromRequest } from "./src/booking-service.mjs";
import { MessageDispatcher } from "./src/dispatcher.mjs";
import { createTransport } from "./src/transport.mjs";
import { LeadService } from "./src/leads.mjs";
import { DashboardApi, DASHBOARD_ROUTES, DASHBOARD_WRITE_ROUTES } from "./src/dashboard-api.mjs";
import { createAiClient } from "./src/ai.mjs";
import { ConversationService } from "./src/conversations.mjs";
import { ReactivationService } from "./src/reactivation.mjs";
import { RetellWebhookService, verifyRetellSignature } from "./src/retell-webhook.mjs";
import { emailAutomationHealth } from "./src/email-health.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const routes = new Map([
  ["/webhook/check-availability", "checkAvailability"],
  ["/webhook/book-appointment", "bookAppointment"],
  ["/webhook/find-appointment", "findAppointment"],
  ["/webhook/reschedule-appointment", "rescheduleAppointment"],
  ["/webhook/cancel-appointment", "cancelAppointment"],
  ["/webhook/log-call", "logCall"],
  ["/webhook/log-complaint", "logComplaint"],
  ["/webhook/log-review-rating", "recordReviewRating"],
  ["/webhook/log-callback", "logCallback"],
  ["/webhook/appointment-outcome", "markAppointmentOutcome"],
  // Service 4.1 — leads from the website form, ManyChat, the receptionist, or manual entry
  ["/webhook/lead", ["leads", "createLead"]],
  ["/webhook/manychat-lead", ["leads", "manychatLead"]],
  ["/webhook/lead-status", ["leads", "updateLeadStatus"]],
  // Inbound customer replies (SMS/WhatsApp/email/Instagram) → AI conversation handler
  ["/webhook/inbound-message", ["conversations", "handleInbound"]]
]);

function writeLog(logger, level, event, details = {}) {
  const sink = logger?.[level] ?? logger?.log;
  if (!sink) return;
  sink.call(logger, JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details
  }));
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

async function readRaw(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1_000_000) throw Object.assign(new Error("The request was too large to process safely."), { statusCode: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

function parseJsonBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("I could not understand that request. Please try again."), { statusCode: 400 });
  }
}

async function readJson(request) {
  return parseJsonBody(await readRaw(request));
}

function requestIdFrom(request) {
  const supplied = request.headers["x-request-id"];
  return typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied)
    ? supplied
    : randomUUID();
}

function requestIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

function secretsMatch(expected, supplied) {
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRateLimiter({ maximum, windowMs }) {
  const clients = new Map();
  let operations = 0;
  return {
    consume(ip, now = Date.now()) {
      operations += 1;
      if (operations % 1_000 === 0) {
        for (const [key, entry] of clients) {
          if (entry.resetAt <= now) clients.delete(key);
        }
      }
      let entry = clients.get(ip);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        clients.set(ip, entry);
      }
      entry.count += 1;
      return {
        allowed: entry.count <= maximum,
        limit: maximum,
        remaining: Math.max(0, maximum - entry.count),
        resetAt: entry.resetAt
      };
    }
  };
}

export async function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const host = options.host ?? env.HOST ?? "0.0.0.0";
  const port = Number(options.port ?? env.PORT ?? 3000);
  const socketPath = options.socketPath ?? env.API_SOCKET_PATH ?? null;
  const dataDir = options.dataDir ?? env.PGLITE_DATA_DIR ?? path.join(here, "data", "pglite");
  const databaseUrl = Object.hasOwn(options, "databaseUrl") ? options.databaseUrl : env.DATABASE_URL;
  const opened = await openDatabase({
    dataDir,
    databaseUrl,
    env,
    logger,
    seed: options.seed ?? true
  });
  const calendar = createCalendar({
    provider: options.calendarProvider ?? env.CALENDAR_PROVIDER ?? "local",
    db: opened.db,
    env
  });
  const service = new BookingService({ db: opened.db, calendar, env, logger });
  const loadTenant = (id) => service.tenant(id);
  const leads = new LeadService({ db: opened.db, tenantLoader: loadTenant, logger });
  const ai = options.ai ?? createAiClient({ env, logger });
  const conversations = new ConversationService({
    db: opened.db, bookingService: service, leadService: leads, ai, tenantLoader: loadTenant, logger
  });
  const reactivation = new ReactivationService({ db: opened.db, ai, tenantLoader: loadTenant, logger });
  const retellWebhook = new RetellWebhookService({
    db: opened.db, tenantLoader: loadTenant, leadService: leads, logger, env
  });
  const services = { booking: service, leads, conversations, reactivation };
  const dashboardApi = new DashboardApi({ db: opened.db, services });
  if (ai?.enabled) writeLog(logger, "info", "ai_enabled", { model: ai.model });
  const dashboardToken = String(env.DASHBOARD_API_TOKEN ?? "");
  if (!dashboardToken) {
    writeLog(logger, "warn", "dashboard_api_disabled", { message: "DASHBOARD_API_TOKEN is unset. /api/dashboard/* returns 503 until it is configured." });
  }
  const transport = options.transport ?? createTransport({ env, logger, fetchImpl: options.fetchImpl ?? fetch });
  const dispatcher = new MessageDispatcher({
    db: opened.db,
    transport,
    logger,
    env,
    maxAttempts: options.messageMaxAttempts,
    batchSize: options.messageDispatchBatchSize,
    baseRetryMs: options.messageRetryBaseMs,
    maxRetryMs: options.messageRetryMaxMs,
    claimLeaseMs: options.messageClaimLeaseMs
  });
  // Two DIFFERENT Retell secrets, easy to confuse:
  //  - RETELL_API_KEY      → verifies Retell's PLATFORM webhook (/webhook/retell,
  //                          call_started/ended/analyzed) via X-Retell-Signature.
  //  - RETELL_WEBHOOK_SECRET → the `x-retell-webhook-secret` header the RECEPTIONIST's
  //                          tool calls send (check-availability, book-appointment, …).
  //                          Must equal the value baked into the agent's tools by
  //                          retell/provision.mjs (i.e. the local .env RETELL_WEBHOOK_SECRET).
  const webhookSecret = String(env.RETELL_WEBHOOK_SECRET ?? "");
  if (webhookSecret && env.RETELL_API_KEY && webhookSecret === env.RETELL_API_KEY) {
    writeLog(logger, "error", "retell_secret_misconfigured", {
      message: "RETELL_WEBHOOK_SECRET is set to the same value as RETELL_API_KEY. They are different secrets — "
        + "the receptionist's tool webhooks (/webhook/check-availability etc.) will 401 until RETELL_WEBHOOK_SECRET "
        + "matches the x-retell-webhook-secret header baked into the agent's tools (retell/provision.mjs / local .env)."
    });
  }
  const retellWebhookAuthMode = String(env.RETELL_WEBHOOK_VERIFY ?? "true").toLowerCase() === "false"
    ? "disabled (RETELL_WEBHOOK_VERIFY=false)"
    : env.RETELL_API_KEY
      ? "signature (RETELL_API_KEY)"
      : webhookSecret
        ? "shared-secret-only — set RETELL_API_KEY for Retell's platform webhook"
        : "unconfigured";
  const toolWebhookAuthMode = webhookSecret
    ? (webhookSecret === env.RETELL_API_KEY
        ? "MISCONFIGURED — RETELL_WEBHOOK_SECRET equals RETELL_API_KEY"
        : "shared-secret (RETELL_WEBHOOK_SECRET)")
    : "OPEN — RETELL_WEBHOOK_SECRET is unset";
  // Tenants the dashboard token is allowed to read. Defaults to the single
  // deployment tenant; set DASHBOARD_TENANT_IDS to a comma list for multi-salon.
  const dashboardTenantAllowList = new Set(
    String(env.DASHBOARD_TENANT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  const resolveDashboardTenant = (url, body = {}) => {
    const fallback = env.TENANT_ID || DEFAULT_TENANT_ID;
    const requested = body.tenantId || body.tenant_id || url.searchParams.get("tenantId");
    if (!requested || requested === fallback) return fallback;
    return dashboardTenantAllowList.has(requested) ? requested : fallback;
  };
  const trustProxy = String(env.TRUST_PROXY ?? "false").toLowerCase() === "true";
  const rateLimitMaximum = positiveInteger(options.rateLimitMax ?? env.RATE_LIMIT_MAX, 120);
  const rateLimitWindowMs = positiveInteger(options.rateLimitWindowMs ?? env.RATE_LIMIT_WINDOW_MS, 60_000);
  const rateLimiter = createRateLimiter({ maximum: rateLimitMaximum, windowMs: rateLimitWindowMs });
  let sweepRunning = false;
  let messagingCycleRunning = false;

  if (!webhookSecret) {
    writeLog(logger, "warn", "webhook_auth_disabled", {
      message: "RETELL_WEBHOOK_SECRET is unset. Webhook requests are currently accepted without authentication."
    });
  }

  const sweepNoShows = async () => {
    if (sweepRunning) return [];
    sweepRunning = true;
    try {
      return await service.sweepNoShows();
    } catch (error) {
      writeLog(logger, "error", "no_show_sweep_failed", { message: error.message });
      return [];
    } finally {
      sweepRunning = false;
    }
  };

  const runMessagingCycle = async () => {
    if (messagingCycleRunning) return null;
    messagingCycleRunning = true;
    try {
      const reviewRequestsScheduled = await service.sweepReviewRequests({ limit: 100 });
      try { await reactivation.tick(); } catch (error) { writeLog(logger, "error", "reactivation_tick_failed", { message: error.message }); }
      const delivery = await dispatcher.runOnce();
      writeLog(logger, "info", "messaging_cycle_complete", { reviewRequestsScheduled, ...delivery });
      return { reviewRequestsScheduled, ...delivery };
    } catch (error) {
      writeLog(logger, "error", "messaging_cycle_failed", { message: error.message });
      return null;
    } finally {
      messagingCycleRunning = false;
    }
  };

  await dispatcher.initialize();
  await sweepNoShows();
  await runMessagingCycle();
  const sweepIntervalMs = Number(options.noShowSweepIntervalMs ?? env.NO_SHOW_SWEEP_INTERVAL_MS ?? 30_000);
  const sweepTimer = setInterval(sweepNoShows, sweepIntervalMs);
  sweepTimer.unref();
  const messagingIntervalMs = Number(options.messageDispatchIntervalMs ?? env.MESSAGE_DISPATCH_INTERVAL_MS ?? 60_000);
  const messagingTimer = setInterval(runMessagingCycle, messagingIntervalMs);
  messagingTimer.unref();

  const server = http.createServer(async (request, response) => {
    const requestId = requestIdFrom(request);
    const startedAt = process.hrtime.bigint();
    const ip = requestIp(request, trustProxy);
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    if (env.NODE_ENV === "production") {
      response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    response.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      writeLog(logger, "info", "http_request", {
        requestId,
        method: request.method,
        path: request.url?.split("?", 1)[0] ?? "/",
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        ip
      });
    });

    try {
      const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
      const rate = rateLimiter.consume(ip);
      response.setHeader("x-ratelimit-limit", String(rate.limit));
      response.setHeader("x-ratelimit-remaining", String(rate.remaining));
      response.setHeader("x-ratelimit-reset", String(Math.ceil(rate.resetAt / 1_000)));
      if (!rate.allowed) {
        response.setHeader("retry-after", String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1_000))));
        return sendJson(response, 429, {
          error: "rate_limited",
          message: "There are too many requests right now. Please wait a moment and try again.",
          requestId
        });
      }

      // Retell's platform webhook (call_started / call_ended / call_analyzed).
      // Primary auth is the Retell signature: X-Retell-Signature verified with
      // RETELL_API_KEY (the key carrying the "Webhook" badge in Retell) over the
      // exact raw request body. The shared RETELL_WEBHOOK_SECRET is accepted as
      // a fallback for our own tooling only — Retell's platform never sends it.
      if (url.pathname === "/webhook/retell") {
        // GET: a readiness probe operators (and Retell's URL check) can hit.
        if (request.method === "GET") {
          return sendJson(response, 200, {
            ok: true,
            endpoint: "/webhook/retell",
            auth: retellWebhookAuthMode,
            expects: "POST with X-Retell-Signature (v=<ts>,d=<hmac>) verified against RETELL_API_KEY",
            requestId
          });
        }
        if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed", requestId });

        const raw = await readRaw(request);
        const retellApiKey = env.RETELL_API_KEY || "";
        const sigHeader = request.headers["x-retell-signature"];
        const signature = verifyRetellSignature(raw, sigHeader, retellApiKey);
        const secretOk = Boolean(webhookSecret) && secretsMatch(webhookSecret, request.headers["x-retell-webhook-secret"]);
        // Explicit, operator-set escape hatch: RETELL_WEBHOOK_VERIFY=false accepts
        // unverified calls (logged loudly) so the pipeline can be tested while a
        // key issue is sorted out. Never leave this off in normal operation.
        const verificationDisabled = String(env.RETELL_WEBHOOK_VERIFY ?? "true").toLowerCase() === "false";

        if (!signature.ok && !secretOk && !verificationDisabled) {
          const reason = retellApiKey ? signature.reason : "RETELL_API_KEY is not set on this service";
          writeLog(logger, "warn", "retell_webhook_auth_failed", {
            requestId,
            ip,
            hasApiKey: Boolean(retellApiKey),
            apiKeyPrefix: retellApiKey ? `${retellApiKey.slice(0, 8)}…` : null,
            hasSignatureHeader: Boolean(sigHeader),
            signatureHeaderSample: sigHeader ? String(Array.isArray(sigHeader) ? sigHeader[0] : sigHeader).slice(0, 14) : null,
            signatureScheme: signature.scheme,
            reason,
            sharedSecretTried: Boolean(request.headers["x-retell-webhook-secret"])
          });
          return sendJson(response, 401, {
            error: "unauthorized",
            message: "Retell signature could not be verified.",
            reason,
            hasApiKey: Boolean(retellApiKey),
            signatureScheme: signature.scheme,
            requestId
          });
        }
        if (verificationDisabled && !signature.ok && !secretOk) {
          writeLog(logger, "warn", "retell_webhook_auth_skipped", {
            requestId, ip, note: "RETELL_WEBHOOK_VERIFY=false — accepting unverified Retell webhook"
          });
        }

        const payload = parseJsonBody(raw);
        const tenantId = tenantIdFromRequest(payload, url, env);
        const result = await retellWebhook.handle(tenantId, payload);
        return sendJson(response, 200, { received: true, verified: signature.ok || secretOk, ...result, requestId });
      }

      const isWebhook = url.pathname.startsWith("/webhook/");
      if (isWebhook && webhookSecret) {
        const providedSecret = request.headers["x-retell-webhook-secret"];
        if (!secretsMatch(webhookSecret, providedSecret)) {
          const provided = providedSecret ? String(Array.isArray(providedSecret) ? providedSecret[0] : providedSecret) : "";
          writeLog(logger, "warn", "webhook_auth_failed", {
            requestId,
            path: url.pathname,
            ip,
            hasHeader: Boolean(provided),
            providedLength: provided.length,
            expectedLength: webhookSecret.length,
            providedLooksLikeApiKey: provided.startsWith("key_"),
            hint: !provided
              ? "request has no x-retell-webhook-secret header"
              : "x-retell-webhook-secret does not match RETELL_WEBHOOK_SECRET on this service — re-run retell/provision.mjs or align the values"
          });
          return sendJson(response, 401, {
            error: "unauthorized",
            message: "I could not verify this call request. Please ask the salon team for help.",
            reason: provided ? "x-retell-webhook-secret mismatch" : "x-retell-webhook-secret header missing",
            requestId
          });
        }
      } else if (isWebhook) {
        writeLog(logger, "warn", "unauthenticated_webhook_accepted", {
          requestId,
          path: url.pathname,
          ip,
          message: "RETELL_WEBHOOK_SECRET is unset. This webhook request was accepted without authentication."
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const inferred = await sweepNoShows();
        let emailAutomation = "unknown";
        try {
          emailAutomation = (await emailAutomationHealth(opened.db, env, env.TENANT_ID || DEFAULT_TENANT_ID)).status;
        } catch { /* health must never fail on this */ }
        return sendJson(response, 200, {
          status: "ok",
          database: opened.driver,
          calendarProvider: calendar.provider,
          retellWebhookAuth: retellWebhookAuthMode,
          toolWebhookAuth: toolWebhookAuthMode,
          aiEnabled: Boolean(ai?.enabled),
          emailAutomation,
          noShowsInferredThisRequest: inferred.length,
          commit: env.RENDER_GIT_COMMIT ? env.RENDER_GIT_COMMIT.slice(0, 7) : null,
          requestId
        });
      }

      if (request.method === "GET" && DASHBOARD_ROUTES.has(url.pathname)) {
        if (!dashboardToken) {
          return sendJson(response, 503, { error: "dashboard_api_disabled", message: "DASHBOARD_API_TOKEN is not configured on the API.", requestId });
        }
        const supplied = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!secretsMatch(dashboardToken, supplied)) {
          writeLog(logger, "warn", "dashboard_auth_failed", { requestId, path: url.pathname, ip });
          return sendJson(response, 401, { error: "unauthorized", message: "Dashboard token is missing or wrong.", requestId });
        }
        const tenantId = resolveDashboardTenant(url);
        return sendJson(response, 200, await dashboardApi[DASHBOARD_ROUTES.get(url.pathname)](tenantId, url));
      }

      if (request.method === "POST" && DASHBOARD_WRITE_ROUTES.has(url.pathname)) {
        if (!dashboardToken) {
          return sendJson(response, 503, { error: "dashboard_api_disabled", requestId });
        }
        const supplied = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!secretsMatch(dashboardToken, supplied)) {
          writeLog(logger, "warn", "dashboard_auth_failed", { requestId, path: url.pathname, ip });
          return sendJson(response, 401, { error: "unauthorized", message: "Dashboard token is missing or wrong.", requestId });
        }
        const writeBody = await readJson(request);
        const tenantId = resolveDashboardTenant(url, writeBody);
        const [targetName, handlerName] = DASHBOARD_WRITE_ROUTES.get(url.pathname);
        const targetObject = targetName === "self" ? dashboardApi : services[targetName];
        return sendJson(response, 200, await targetObject[handlerName](tenantId, writeBody));
      }

      const method = routes.get(url.pathname);
      if (request.method !== "POST" || !method) {
        return sendJson(response, 404, {
          error: "not_found",
          message: "That API endpoint does not exist.",
          requestId
        });
      }

      const rawBody = await readJson(request);
      // Retell custom tools may nest the arguments under `args` (when the tool
      // isn't configured with args_at_root) and add call metadata. Flatten so
      // handlers see the parameters regardless of that setting. Also accepts
      // `parameters` / `arguments` as seen from some Retell versions.
      const nested = rawBody.args ?? rawBody.parameters ?? rawBody.arguments;
      const body = nested && typeof nested === "object" && !Array.isArray(nested)
        ? { ...rawBody, ...nested }
        : rawBody;
      const tenantId = tenantIdFromRequest(body, url, env);
      const [target, handler] = Array.isArray(method) ? [services[method[0]], method[1]] : [service, method];
      const result = await target[handler](tenantId, body);
      return sendJson(response, 200, result);
    } catch (error) {
      writeLog(logger, "error", "http_request_failed", {
        requestId,
        method: request.method,
        path: request.url?.split("?", 1)[0] ?? "/",
        message: error.message,
        errorCode: error.code ?? null
      });
      const isSafeClientError = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500;
      return sendJson(response, isSafeClientError ? error.statusCode : 500, {
        error: isSafeClientError ? "invalid_request" : "internal_error",
        message: isSafeClientError
          ? error.message
          : "The request could not be completed safely. Please ask the salon team for help.",
        requestId
      });
    }
  });

  server.requestTimeout = positiveInteger(env.HTTP_REQUEST_TIMEOUT_MS, 15_000);
  server.headersTimeout = positiveInteger(env.HTTP_HEADERS_TIMEOUT_MS, 10_000);
  server.keepAliveTimeout = positiveInteger(env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 5_000);

  let closePromise = null;
  return {
    db: opened.db,
    databaseDriver: opened.driver,
    calendar,
    dispatcher,
    service,
    leads,
    server,
    seeded: opened.seeded,
    dataDir,
    sweepNoShows,
    runMessagingCycle,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        const listenArgs = socketPath ? [socketPath] : [port, host];
        server.listen(...listenArgs, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (socketPath) return "http://localhost";
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      return `http://${host}:${actualPort}`;
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(sweepTimer);
        clearInterval(messagingTimer);
        try {
          if (server.listening) {
            await new Promise((resolve, reject) => {
              const forceTimer = setTimeout(() => server.closeAllConnections?.(), 10_000);
              server.close((error) => {
                clearTimeout(forceTimer);
                if (error) reject(error);
                else resolve();
              });
              server.closeIdleConnections?.();
            });
          }
        } finally {
          await opened.db.close();
        }
      })();
      return closePromise;
    }
  };
}

async function main() {
  const runtime = await createRuntime();
  const baseUrl = await runtime.start();
  writeLog(console, "info", "server_listening", {
    baseUrl,
    port: runtime.server.address()?.port ?? process.env.PORT ?? 3000,
    databaseDriver: runtime.databaseDriver,
    calendarProvider: runtime.calendar.provider,
    seeded: runtime.seeded
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeLog(console, "info", "graceful_shutdown_started", { signal });
    try {
      await runtime.close();
      writeLog(console, "info", "graceful_shutdown_complete", { signal });
      process.exitCode = 0;
    } catch (error) {
      writeLog(console, "error", "graceful_shutdown_failed", { signal, message: error.message });
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    writeLog(console, "error", "server_start_failed", { message: error.message });
    process.exitCode = 1;
  });
}
