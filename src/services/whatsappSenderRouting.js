"use strict";

// The multi-number foundation is deliberately read-only. This module never
// subscribes an account, sends messages, or reads/stores provider credentials.
// The existing production runtime remains single-sender until all outbound,
// policy, and contact-identity paths have been migrated and activated.
const MESSAGE_FIELDS = new Set(["messages", "smb_message_echoes"]);

class WhatsAppSenderRoutingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WhatsAppSenderRoutingError";
    this.code = code;
  }
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requirePhoneId(value) {
  const id = clean(value);
  if (!id || !/^[0-9]+$/.test(id)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_PHONE_ID_INVALID",
      "WhatsApp sender must have a numeric Meta phone number ID."
    );
  }
  return id;
}

function requireAccountId(value) {
  const id = clean(value);
  if (!id || !/^[0-9]+$/.test(id)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_ACCOUNT_ID_INVALID",
      "WhatsApp sender must have a numeric Meta account ID."
    );
  }
  return id;
}

function normalizeSender(sender) {
  if (!sender || typeof sender !== "object") {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_INVALID", "WhatsApp sender definition is required."
    );
  }
  const key = clean(sender.key);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_KEY_INVALID", "WhatsApp sender key is invalid."
    );
  }
  const state = clean(sender.state) || "disabled";
  if (!["disabled", "testing", "active"].includes(state)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_STATE_INVALID", "WhatsApp sender state is invalid."
    );
  }
  return Object.freeze({
    key,
    phoneNumberId: requirePhoneId(sender.phoneNumberId),
    accountId: requireAccountId(sender.accountId),
    displayName: clean(sender.displayName) || key,
    state,
    coexistenceEnabled: sender.coexistenceEnabled === true,
  });
}

function createSenderRegistry(definitions) {
  if (!Array.isArray(definitions)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_REGISTRY_INVALID", "Sender registry must be an array."
    );
  }
  const byPhone = new Map();
  const byKey = new Map();
  for (const definition of definitions) {
    const sender = normalizeSender(definition);
    if (byPhone.has(sender.phoneNumberId) || byKey.has(sender.key)) {
      throw new WhatsAppSenderRoutingError(
        "WHATSAPP_SENDER_DUPLICATE", "WhatsApp sender ID or key is duplicated."
      );
    }
    byPhone.set(sender.phoneNumberId, sender);
    byKey.set(sender.key, sender);
  }
  return Object.freeze({ byPhone, byKey });
}

// The number receiving the message is value.metadata.phone_number_id, NOT
// message.from, message.to, or metadata.display_phone_number. For a shared
// Meta app, entry.id is the owning WhatsApp account; validate both identities.
function senderEvidenceForChange(entry, change) {
  const value = change?.value;
  const count = (Array.isArray(value?.messages) ? value.messages.length : 0)
    + (Array.isArray(value?.statuses) ? value.statuses.length : 0)
    + (change?.field === "smb_message_echoes" && Array.isArray(value?.message_echoes)
      ? value.message_echoes.length : 0);
  if (count === 0) return null;
  return {
    accountId: clean(entry?.id),
    phoneNumberId: clean(value?.metadata?.phone_number_id),
    eventCount: count,
  };
}

function inspectWhatsAppWebhookSenders(body) {
  const evidence = [];
  for (const entry of (Array.isArray(body?.entry) ? body.entry : [])) {
    for (const change of (Array.isArray(entry?.changes) ? entry.changes : [])) {
      const record = senderEvidenceForChange(entry, change);
      if (record) evidence.push(record);
    }
  }
  return evidence;
}

function resolveWhatsAppSender({ accountId, phoneNumberId }, registry, {
  allowTesting = false,
} = {}) {
  if (!registry?.byPhone || !(registry.byPhone instanceof Map)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_REGISTRY_UNAVAILABLE", "Sender registry is unavailable."
    );
  }
  const id = requirePhoneId(phoneNumberId);
  const account = requireAccountId(accountId);
  const sender = registry.byPhone.get(id);
  if (!sender || sender.accountId !== account) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_NOT_AUTHORIZED",
      "WhatsApp webhook sender does not match a registered phone and account."
    );
  }
  if (sender.state !== "active" && !(allowTesting && sender.state === "testing")) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_DISABLED", "WhatsApp sender is not active."
    );
  }
  return sender;
}

function validateWhatsAppWebhookSenders(body, registry, options = {}) {
  // Validate the complete batch before persisting any individual contact.
  // Never fall back to the legacy sending number for an unknown sender.
  const evidence = inspectWhatsAppWebhookSenders(body);
  const resolved = evidence.map((event) =>
    resolveWhatsAppSender(event, registry, options)
  );
  return { evidence, resolved };
}

function conversationKeyForSender(senderKey, customerPhone) {
  const key = clean(senderKey);
  const phone = String(customerPhone || "").replace(/[^0-9]/g, "");
  if (!key || phone.length < 8) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_CONVERSATION_IDENTITY_INVALID",
      "A sender key and customer phone are required."
    );
  }
  return `whatsapp:${key}:${phone}`;
}

module.exports = {
  WhatsAppSenderRoutingError,
  conversationKeyForSender,
  createSenderRegistry,
  inspectWhatsAppWebhookSenders,
  normalizeSender,
  resolveWhatsAppSender,
  validateWhatsAppWebhookSenders,
};
