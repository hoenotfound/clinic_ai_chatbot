"use strict";

// Phase 2 transport preparation only. Nothing in production calls this module.
// Do not wire it to Inbox/AI/templates/retries until sender-scoped billing,
// status reconciliation and reply-window checks are implemented.
const { pool } = require("../db/db");
const { classifyWhatsappSendFailure, classifyWhatsappAcceptedResponse } = require("./whatsappService");

const GRAPH_VERSION = "v26.0";
const DEFAULT_TIMEOUT_MS = 10000;
const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

class OutboundSenderNotReady extends Error {
  constructor() {
    super("The secondary WhatsApp sender is not authorized for outbound transport.");
    this.name = "OutboundSenderNotReady";
    this.code = "whatsapp_sender_not_ready";
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
function digits(value) {
  return /^[0-9]+$/.test(clean(value));
}
function reject() {
  throw new OutboundSenderNotReady();
}

// The caller's contact is never the authority. Verify the bound contact,
// sender row and customer phone together before resolving an API credential.
async function resolveSecondaryOutboundBinding(contact, { database = pool, env = process.env } = {}) {
  if (env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED !== "true" ||
      env.WHATSAPP_MULTI_NUMBER_READ_ENABLED !== "true" ||
      env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED !== "true" ||
      env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true") reject();

  const id = Number(contact?.id);
  if (contact?.channel !== "whatsapp" || !Number.isSafeInteger(id) || id <= 0 ||
      !/^[0-9]{8,15}$/.test(clean(contact?.whatsapp_number)) ||
      !digits(env.WHATSAPP_PHONE_NUMBER_ID) || !digits(env.WHATSAPP_WABA_ID) ||
      !digits(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
      !digits(env.WHATSAPP_SECONDARY_WABA_ID) ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(clean(env.WHATSAPP_SECONDARY_SENDER_KEY)) ||
      !clean(env.WHATSAPP_SECONDARY_TOKEN) ||
      clean(env.WHATSAPP_SECONDARY_SENDER_KEY) === clean(env.WHATSAPP_PRIMARY_SENDER_KEY) ||
      clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) === clean(env.WHATSAPP_PHONE_NUMBER_ID) ||
      clean(env.WHATSAPP_SECONDARY_WABA_ID) === clean(env.WHATSAPP_WABA_ID) &&
        clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) === clean(env.WHATSAPP_PHONE_NUMBER_ID)) reject();

  let result;
  try {
    result = await database.query(
      "SELECT c.whatsapp_number, c.whatsapp_sender_id, " +
      "sc.sender_id AS bound_sender_id, sc.customer_wa_id, sc.state AS binding_state, " +
      "sa.sender_key, sa.meta_phone_number_id, sa.meta_account_id, " +
      "sa.state AS sender_state, sa.coexistence_enabled AS sender_coexistence_enabled " +
      "FROM contacts c JOIN whatsapp_sender_conversations sc ON sc.contact_id=c.id " +
      "JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id " +
      "WHERE c.id=$1 AND c.channel='whatsapp'",
      [id]
    );
  } catch {
    reject();
  }
  const rows = result?.rows || [];
  if (rows.length !== 1) reject();
  const row = rows[0];
  // A manually toggled active state alone must NOT reopen a Business App
  // coexistence number that a signed disconnect suspended. The lifecycle
  // handler clears coexistence_enabled as a separate, durable safety latch.
  // Legacy non-coexistence synthetic transport fixtures have no E164 pin.
  const coexistencePinned = Boolean(clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164)) ||
    env.WHATSAPP_COEXISTENCE_ENABLED === "true";
  if (row.binding_state !== "bound" || row.sender_state !== "active" ||
      (coexistencePinned && row.sender_coexistence_enabled !== true) ||
      String(row.whatsapp_sender_id) !== String(row.bound_sender_id) ||
      !row.whatsapp_sender_id ||
      row.whatsapp_number !== contact.whatsapp_number ||
      row.customer_wa_id !== contact.whatsapp_number ||
      row.sender_key !== clean(env.WHATSAPP_SECONDARY_SENDER_KEY) ||
      row.meta_phone_number_id !== clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
      row.meta_account_id !== clean(env.WHATSAPP_SECONDARY_WABA_ID) ||
      (contact.whatsapp_sender_key && contact.whatsapp_sender_key !== row.sender_key) ||
      (contact.whatsapp_sender_phone_number_id &&
        contact.whatsapp_sender_phone_number_id !== row.meta_phone_number_id) ||
      (contact.whatsapp_sender_account_id &&
        contact.whatsapp_sender_account_id !== row.meta_account_id)) reject();
  return Object.freeze({
    senderKey: row.sender_key,
    phoneNumberId: row.meta_phone_number_id,
    accountId: row.meta_account_id,
    // Never serialize, log, or return this object to an HTTP endpoint.
    token: clean(env.WHATSAPP_SECONDARY_TOKEN),
    recipient: row.customer_wa_id,
  });
}

function createSecondaryOutboundTransport(binding, {
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  // Validated binding can only be minted by resolveSecondaryOutboundBinding.
  if (!boundSenders.has(binding) || typeof fetchImpl !== "function") reject();
  const { phoneNumberId, token, recipient } = binding;
  const endpoint = "https://graph.facebook.com/" + GRAPH_VERSION + "/" + phoneNumberId;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  async function request(suffix, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(endpoint + suffix, { ...options, signal: controller.signal });
      const body = await response.text();
      if (!response.ok) return {
        ...classifyWhatsappSendFailure(response.status, body),
        success: false,
        // Only an unambiguous synchronous client rejection proves Meta did
        // not accept this message. 408, 409, 425, 429 and 5xx are uncertain.
        definitivelyRejected: [400,401,403,404,422].includes(response.status),
      };
      let data;
      try { data = JSON.parse(body); } catch { return { success: false, wamid: null, ambiguous: true, retryable: false, error: "Unverifiable Meta response." }; }
      return { success: true, data };
    } catch {
      return { success: false, wamid: null, ambiguous: true, retryable: false, error: "Meta send outcome is unknown; reconcile before retrying." };
    } finally {
      clearTimeout(timer);
    }
  }
  async function send(payload) {
    const result = await request("/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: recipient, ...payload }),
    });
    return result.success ? classifyWhatsappAcceptedResponse(result.data) : result;
  }
  async function uploadMedia(buffer, mimeType, filename) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || !clean(mimeType) || !clean(filename)) {
      return { success: false, mediaId: null, error: "Invalid media upload." };
    }
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const result = await request("/media", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      body: form,
    });
    if (!result.success) return { ...result, mediaId: null };
    const mediaId = clean(result.data?.id);
    return mediaId ? { success: true, mediaId } :
      { success: false, mediaId: null, ambiguous: true, retryable: false, error: "Unverifiable Meta upload response." };
  }

  return Object.freeze({
    senderKey: binding.senderKey,
    async sendText(text, { replyToProviderMessageId = null } = {}) {
      if (!clean(text)) return { success: false, error: "Message text is required." };
      return send({ type: "text", text: { body: text },
        ...(clean(replyToProviderMessageId) ? { context: { message_id: clean(replyToProviderMessageId) } } : {}) });
    },
    async sendInteractiveButtons(body, buttons) {
      if (!clean(body) || body.length > 1024 || !Array.isArray(buttons) ||
          buttons.length !== 2 || buttons.some(b => !clean(b?.id) || !clean(b?.title) ||
            b.id.length > 256 || b.title.length > 20)) {
        return { success: false, error: "Invalid interactive button payload." };
      }
      return send({ type: "interactive", interactive: { type: "button", body: { text: body },
        action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) } } });
    },
    async sendImageByUrl(url, caption = "", { replyToProviderMessageId = null } = {}) {
      if (!/^https:\/\//.test(clean(url))) return { success: false, error: "HTTPS image URL required." };
      return send({ type: "image", image: { link: url, ...(caption ? { caption } : {}) },
        ...(clean(replyToProviderMessageId) ? { context: { message_id: clean(replyToProviderMessageId) } } : {}) });
    },
    async sendMediaById(type, mediaId, {
      caption = "", filename = "", voice = false, replyToProviderMessageId = null,
    } = {}) {
      if (!MEDIA_TYPES.has(type) || !clean(mediaId) || (voice && type !== "audio")) {
        return { success: false, error: "Invalid WhatsApp media payload." };
      }
      const media = { id: mediaId,
        ...(caption && ["image", "video", "document"].includes(type) ? { caption } : {}),
        ...(filename && type === "document" ? { filename } : {}),
        ...(voice && type === "audio" ? { voice: true } : {}) };
      return send({ type, [type]: media,
        ...(clean(replyToProviderMessageId) ? { context: { message_id: clean(replyToProviderMessageId) } } : {}) });
    },
    async sendTemplatePayload(name, languageCode, components = []) {
      // This is transport ONLY: caller must check the approved sender-specific
      // template catalog, marketing consent, policy window and billing first.
      if (!/^[a-z0-9_]+$/.test(clean(name)) ||
          !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(clean(languageCode)) ||
          !Array.isArray(components)) return { success: false, error: "Invalid template payload." };
      return send({ type: "template", template: {
        name, language: { code: languageCode }, components } });
    },
    uploadMedia,
  });
}

// An identity returned by a fake caller must never mint an outbound transport.
const boundSenders = new WeakSet();
async function createVerifiedSecondaryOutboundTransport(contact, options = {}) {
  const binding = await resolveSecondaryOutboundBinding(contact, options);
  boundSenders.add(binding);
  const transport = createSecondaryOutboundTransport(binding, options);
  // A transport kept in memory must NOT survive a sender deactivation,
  // contact reassignment or credential rotation unnoticed. Re-verify on
  // every request, including media uploads and template payloads.
  async function revalidate() {
    const current = await resolveSecondaryOutboundBinding(contact, options);
    if (current.senderKey !== binding.senderKey ||
        current.phoneNumberId !== binding.phoneNumberId ||
        current.accountId !== binding.accountId ||
        current.recipient !== binding.recipient ||
        current.token !== binding.token) reject();
  }
  const methods = ["sendText", "sendInteractiveButtons", "sendImageByUrl",
    "sendMediaById", "sendTemplatePayload", "uploadMedia"];
  const wrapped = { senderKey: transport.senderKey };
  for (const method of methods) {
    wrapped[method] = async (...args) => {
      await revalidate();
      return transport[method](...args);
    };
  }
  return Object.freeze(wrapped);
}

module.exports = {
  OutboundSenderNotReady,
  createVerifiedSecondaryOutboundTransport,
};
