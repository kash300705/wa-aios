export class TransportConfigurationError extends Error {}

function log(logger, event, details = {}) {
  const sink = logger?.info ?? logger?.log;
  if (!sink) return;
  sink.call(logger, JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "info",
    event,
    ...details
  }));
}

function normaliseProvider(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]/g, "_");
}

function providerForChannel(channel, tenant, env) {
  const config = tenant.messaging_config ?? {};
  const fromTenant = config.channels?.[channel]?.provider
    ?? config.providers?.[channel]
    ?? config[`${channel}Provider`];
  const fromEnvironment = env[`MESSAGE_TRANSPORT_${String(channel).toUpperCase()}`]
    ?? env.MESSAGING_TRANSPORT_PROVIDER;
  const selected = normaliseProvider(fromTenant ?? fromEnvironment ?? (config.mode === "stub" ? "null" : "null"));
  if (["", "null", "stub", "none"].includes(selected)) return "null";
  if (selected === "resend") return "resend";
  if (["whatsapp_cloud", "whatsappcloud", "meta_whatsapp"].includes(selected)) return "whatsapp_cloud";
  if (selected === "manychat") return "manychat";
  throw new TransportConfigurationError(
    `Unknown message transport ${selected || "(empty)"} for ${channel}. Expected null, resend, whatsapp_cloud, or manychat.`
  );
}

export class NullTransport {
  constructor({ logger = console } = {}) {
    this.provider = "null";
    this.logger = logger;
  }

  async send({ message, recipient, rendered }) {
    log(this.logger, "message_would_send", {
      messageId: message.id,
      channel: message.channel,
      to: recipient,
      templateId: message.template_id,
      subject: rendered.subject || null,
      hasHtml: Boolean(rendered.html),
      body: rendered.body
    });
    return { status: "stubbed", provider: this.provider, recipient: recipient ?? null, subject: rendered.subject ?? null };
  }
}

/** Resend email. The sending identity is tenant-aware for white-label:
 *  messaging_config.email.from / .replyTo override the deployment defaults
 *  (EMAIL_FROM / REPLY_TO_EMAIL, with MAIL_FROM kept as a legacy fallback). */
export class ResendEmail {
  constructor({ apiKey, defaultFrom, defaultReplyTo, fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new TransportConfigurationError(
        "Email transport is set to Resend, but RESEND_API_KEY is missing. No fallback transport was used."
      );
    }
    this.provider = "resend";
    this.apiKey = apiKey;
    this.defaultFrom = defaultFrom || "";
    this.defaultReplyTo = defaultReplyTo || "";
    this.fetchImpl = fetchImpl;
  }

  resolveFrom(tenant) {
    const emailConfig = tenant?.messaging_config?.email ?? {};
    const raw = String(emailConfig.from || this.defaultFrom || "").trim();
    if (!raw) {
      throw new TransportConfigurationError(
        "Resend is selected but no sender address is configured. Set EMAIL_FROM on the API "
        + "(or messaging_config.email.from for this tenant) to a verified Resend domain address."
      );
    }
    if (raw.includes("<")) return raw;
    const senderName = emailConfig.senderName || tenant?.messaging_config?.senderName || tenant?.name;
    return senderName ? `${senderName} <${raw}>` : raw;
  }

  resolveReplyTo(tenant) {
    const emailConfig = tenant?.messaging_config?.email ?? {};
    return String(emailConfig.replyTo || this.defaultReplyTo || tenant?.contact_config?.email || "").trim() || null;
  }

  async send({ message, recipient, rendered, tenant }) {
    if (!recipient) throw new Error(`Message ${message.id} has no email recipient.`);
    const from = this.resolveFrom(tenant);
    const replyTo = this.resolveReplyTo(tenant);
    const payload = {
      from,
      to: [recipient],
      subject: rendered.subject || "Message from your salon",
      text: rendered.body
    };
    if (rendered.html) payload.html = rendered.html;
    if (replyTo) payload.reply_to = replyTo;
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `wa-aios-message-${message.id}`
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend API ${response.status}: ${detail || response.statusText}`);
    }
    const result = await response.json();
    return {
      status: "sent",
      provider: this.provider,
      providerMessageId: result.id ?? null,
      recipient,
      subject: payload.subject
    };
  }
}

export class WhatsAppCloud {
  constructor({ token, phoneNumberId, apiVersion = "v20.0", fetchImpl = fetch } = {}) {
    if (!token) {
      throw new TransportConfigurationError(
        "WhatsApp Cloud transport is selected, but WHATSAPP_TOKEN is missing. No fallback transport was used."
      );
    }
    if (!phoneNumberId) {
      throw new TransportConfigurationError(
        "WhatsApp Cloud transport is selected, but WHATSAPP_PHONE_NUMBER_ID is missing. No fallback transport was used."
      );
    }
    this.provider = "whatsapp_cloud";
    this.token = token;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion = apiVersion;
    this.fetchImpl = fetchImpl;
  }

  async send({ message, recipient, rendered }) {
    if (!recipient) throw new Error(`Message ${message.id} has no WhatsApp recipient.`);
    const components = rendered.whatsapp.bodyParameters.length
      ? [{
          type: "body",
          parameters: rendered.whatsapp.bodyParameters.map((text) => ({ type: "text", text }))
        }]
      : [];
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipient.replace(/^\+/, ""),
          type: "template",
          template: {
            name: rendered.whatsapp.name,
            language: { code: rendered.whatsapp.languageCode },
            components
          }
        })
      }
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `WhatsApp Cloud API ${response.status}: ${detail || response.statusText}. `
        + "The selected template must be approved in Meta before it can send."
      );
    }
    const result = await response.json();
    return {
      status: "sent",
      provider: this.provider,
      providerMessageId: result.messages?.[0]?.id ?? null
    };
  }
}

export class ChannelTransport {
  constructor({ env = process.env, logger = console, fetchImpl = fetch } = {}) {
    this.env = env;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.provider = "router";
  }

  forMessage(message, tenant) {
    const provider = providerForChannel(message.channel, tenant, this.env);
    if (provider === "null") return new NullTransport({ logger: this.logger });
    if (provider === "resend") {
      if (message.channel !== "email") {
        throw new TransportConfigurationError("Resend can only be selected for the email channel.");
      }
      return new ResendEmail({
        apiKey: this.env.RESEND_API_KEY,
        defaultFrom: this.env.EMAIL_FROM || this.env.MAIL_FROM,
        defaultReplyTo: this.env.REPLY_TO_EMAIL,
        fetchImpl: this.fetchImpl
      });
    }
    if (provider === "whatsapp_cloud") {
      if (message.channel !== "whatsapp") {
        throw new TransportConfigurationError("WhatsApp Cloud can only be selected for the whatsapp channel.");
      }
      return new WhatsAppCloud({
        token: this.env.WHATSAPP_TOKEN,
        phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID,
        apiVersion: this.env.WHATSAPP_GRAPH_API_VERSION || "v20.0",
        fetchImpl: this.fetchImpl
      });
    }
    if (provider === "manychat") {
      if (!["instagram", "whatsapp"].includes(message.channel)) {
        throw new TransportConfigurationError("ManyChat can only be selected for the instagram or whatsapp channel.");
      }
      return new ManyChatTransport({ apiKey: this.env.MANYCHAT_API_KEY, fetchImpl: this.fetchImpl });
    }
    throw new TransportConfigurationError(`No transport is available for ${message.channel}.`);
  }

  async send(input) {
    return this.forMessage(input.message, input.tenant).send(input);
  }
}

export function createTransport(options = {}) {
  return new ChannelTransport(options);
}

/**
 * ManyChat — Instagram DM (and WhatsApp via ManyChat) delivery. Recipient is the ManyChat
 * subscriber id stored on the contact. Requires MANYCHAT_API_KEY. Inert (throws) without it —
 * never silently falls back to NullTransport.
 * API: POST https://api.manychat.com/fb/sending/sendContent  (Bearer key)
 */
export class ManyChatTransport {
  constructor({ apiKey, fetchImpl = fetch, apiBase = "https://api.manychat.com" } = {}) {
    if (!apiKey) {
      throw new TransportConfigurationError(
        "ManyChat transport selected but MANYCHAT_API_KEY is unset. Set it (ManyChat → Settings → API) or choose another provider."
      );
    }
    this.provider = "manychat";
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, "");
  }

  async send({ recipient, rendered, message }) {
    if (!recipient) throw new Error("ManyChat send requires the contact's manychat_subscriber_id.");
    const response = await this.fetchImpl(`${this.apiBase}/fb/sending/sendContent`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        subscriber_id: recipient,
        data: { version: "v2", content: { messages: [{ type: "text", text: rendered.body }] } },
        // Outside Meta's 24h window a tag is mandatory; appointment/lead updates qualify.
        message_tag: "ACCOUNT_UPDATE"
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`ManyChat ${response.status}: ${text.slice(0, 300)}`);
    let json = {};
    try { json = JSON.parse(text); } catch {}
    if (json.status && json.status !== "success") throw new Error(`ManyChat rejected the send: ${text.slice(0, 300)}`);
    return { status: "sent", provider: "manychat", providerMessageId: json.message_id ?? null, channel: message.channel };
  }
}
