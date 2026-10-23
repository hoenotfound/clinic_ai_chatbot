"use strict";

// Read-only multi-number foundation. This is not wired to live webhooks or
// outbound sending until all sender-specific identity/policy work is ready.
const { normalizeWhatsappNumber } = require("../utils/whatsappPhoneNormalization");

const REGISTRY_LOOKUPS = new WeakMap();
const ROUTABLE_FIELDS = new Set(["messages", "smb_message_echoes"]);
// Passive coexistence sync is intentionally not a customer message or a
// delivery receipt. Any newly introduced Meta event requires explicit review.
const PASSIVE_FIELDS = new Set(["history", "smb_app_state_sync"]);

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
  if (!/^[0-9]+$/.test(id)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_PHONE_ID_INVALID",
      "WhatsApp sender must have a numeric Meta phone number ID."
    );
  }
  return id;
}

function requireAccountId(value) {
  const id = clean(value);
  if (!/^[0-9]+$/.test(id)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_ACCOUNT_ID_INVALID",
      "WhatsApp sender must have a numeric Meta account ID."
    );
  }
  return id;
}

function requireSenderKey(value) {
  const key = clean(value);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_KEY_INVALID",
      "WhatsApp sender key is invalid."
    );
  }
  return key;
}

function normalizeSender(sender) {
  if (!sender || typeof sender !== "object" || Array.isArray(sender)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_INVALID", "WhatsApp sender definition is required."
    );
  }
  const key = requireSenderKey(sender.key);
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

  // Maps are held only by this closure. Object.freeze(Map) does NOT make it
  // immutable, so never expose either Map to consumers or JSON responses.
  const registry = Object.freeze({
    size: byPhone.size,
    findByPhoneNumberId(phoneNumberId) {
      return byPhone.get(phoneNumberId) || null;
    },
    findByKey(key) {
      return byKey.get(key) || null;
    },
  });
  REGISTRY_LOOKUPS.set(registry, true);
  return registry;
}

function requireRegistry(registry) {
  if (!registry || !REGISTRY_LOOKUPS.has(registry)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_REGISTRY_UNAVAILABLE",
      "Sender registry is unavailable or was not validated."
    );
  }
}

function invalidWebhook(message) {
  return new WhatsAppSenderRoutingError("WHATSAPP_WEBHOOK_INVALID", message);
}

function unsupportedWebhookField(field) {
  return new WhatsAppSenderRoutingError(
    "WHATSAPP_WEBHOOK_UNSUPPORTED_CHANGE",
    `Unrecognized WhatsApp webhook field ${JSON.stringify(field)}. Review or quarantine the batch before enabling routing.`
  );
}

function inspectWebhookChanges(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || body.object !== "whatsapp_business_account"
      || !Array.isArray(body.entry)) {
    throw invalidWebhook("Expected a WhatsApp business account webhook with an entry array.");
  }
  const evidence = [];
  const passive = [];
  for (const entry of body.entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || !Array.isArray(entry.changes)) {
      throw invalidWebhook("Webhook entry must contain a changes array.");
    }
    // Even passive sync must retain a verifiable account for audit.
    const accountId = entry.changes.length ? requireAccountId(entry.id) : null;
    for (const change of entry.changes) {
      if (!change || typeof change !== "object" || Array.isArray(change)
          || !clean(change.field) || !change.value
          || typeof change.value !== "object" || Array.isArray(change.value)) {
        throw invalidWebhook("Webhook change has an invalid field or value.");
      }
      const field = change.field;
      if (PASSIVE_FIELDS.has(field)) {
        // Keep an audit classification. No AI job, contact creation or send.
        passive.push(Object.freeze({ accountId, field }));
        continue;
      }
      if (!ROUTABLE_FIELDS.has(field)) {
        // Fail closed rather than silently interpreting future Meta events
        // as WhatsApp conversations. The production handler must quarantine
        // unknown events, not retry them indefinitely.
        throw unsupportedWebhookField(field);
      }
      const value = change.value;
      const names = field === "messages" ? ["messages", "statuses"] : ["message_echoes"];
      for (const name of names) {
        if (value[name] !== undefined && !Array.isArray(value[name])) {
          throw invalidWebhook(`WhatsApp ${field} field ${name} must be an array.`);
        }
      }
      const count = names.reduce((sum, name) => sum + (value[name]?.length || 0), 0);
      if (!count) continue;
      evidence.push(Object.freeze({
        accountId,
        phoneNumberId: clean(value.metadata?.phone_number_id),
        eventCount: count,
      }));
    }
  }
  return { evidence, passive };
}

// The sender is Meta value.metadata.phone_number_id; 'from' and 'to' are
// customer/business message participants, not trustworthy sender selectors.
function inspectWhatsAppWebhookSenders(body) {
  return inspectWebhookChanges(body).evidence;
}

function resolveWhatsAppSender({ accountId, phoneNumberId }, registry) {
  requireRegistry(registry);
  const id = requirePhoneId(phoneNumberId);
  const account = requireAccountId(accountId);
  const sender = registry.findByPhoneNumberId(id);
  if (!sender || sender.accountId !== account) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_NOT_AUTHORIZED",
      "WhatsApp webhook sender does not match a registered phone and account."
    );
  }
  // There is deliberately NO 'allowTesting' escape hatch. Testing senders
  // can be inspected, but may never authorize live inbound/AI processing.
  // Activation requires an explicit and separately approved state transition.
  if (sender.state !== "active") {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_SENDER_DISABLED",
      "WhatsApp sender is not active."
    );
  }
  return sender;
}

function validateWhatsAppWebhookSenders(body, registry) {
  requireRegistry(registry);
  // Validate every actionable event BEFORE persisting any part of a batch.
  const { evidence, passive } = inspectWebhookChanges(body);
  const resolved = evidence.map((event) => resolveWhatsAppSender(event, registry));
  return { evidence, resolved, passive };
}

function conversationKeyForSender(senderKey, customerPhone) {
  const key = requireSenderKey(senderKey);
  if (typeof customerPhone !== "string"
      || !/^[+\d\s().-]+$/.test(customerPhone)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_CONVERSATION_IDENTITY_INVALID",
      "A valid customer phone number is required."
    );
  }
  const phone = normalizeWhatsappNumber(customerPhone);
  if (!/^\d{8,15}$/.test(phone)) {
    throw new WhatsAppSenderRoutingError(
      "WHATSAPP_CONVERSATION_IDENTITY_INVALID",
      "A valid customer phone number is required."
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
