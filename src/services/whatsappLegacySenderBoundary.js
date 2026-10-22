"use strict";

// Compatibility boundary only. Never interprets a second business number as a
// legacy Neutro contact. Full multi-number routing is NOT enabled here.
const crypto = require("node:crypto");
const ROUTABLE_FIELDS = new Set(["messages", "smb_message_echoes"]);
const PASSIVE_FIELDS = new Set(["history", "smb_app_state_sync"]);
const MAX_QUARANTINE_EVENTS = 200;
const MAX_META_ENTRIES = 200;
const MAX_CHANGE_ITEMS = 1000;

class LegacySenderBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LegacySenderBoundaryError";
    this.code = code;
  }
}

function digits(value) {
  return typeof value === "string" && /^\d+$/.test(value.trim())
    ? value.trim() : null;
}

function senderEvidence(entry, change) {
  return {
    phoneNumberId: digits(change?.value?.metadata?.phone_number_id),
    accountId: digits(entry?.id),
  };
}

function hasEvents(value, field) {
  const names = field === "messages" ? ["messages", "statuses"] : ["message_echoes"];
  return names.some((name) => Array.isArray(value?.[name]) && value[name].length > 0);
}

function quarantine(entry, change, reason) {
  const evidence = senderEvidence(entry, change);
  const field = typeof change?.field === "string" ? change.field.slice(0, 100) : "invalid";
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify({ account: entry?.id ?? null, change }))
    .digest("hex");
  return Object.freeze({
    fingerprint, reason, field,
    accountId: evidence.accountId,
    phoneNumberId: evidence.phoneNumberId,
  });
}

function validateChange(entry, change, expectedPhone, expectedAccount, strictMissingMetadata) {
  if (!change || typeof change !== "object" || Array.isArray(change)
      || typeof change.field !== "string"
      || !change.value || typeof change.value !== "object"
      || Array.isArray(change.value)) return "malformed_whatsapp_change";

  const field = change.field;
  if (!ROUTABLE_FIELDS.has(field) && !PASSIVE_FIELDS.has(field)) {
    return "unsupported_whatsapp_event";
  }
  const value = change.value;
  if (value.metadata !== undefined && (value.metadata === null
      || typeof value.metadata !== "object" || Array.isArray(value.metadata))) {
    return "malformed_whatsapp_change";
  }
  if (field === "messages" && value.contacts !== undefined
      && (!Array.isArray(value.contacts)
        || value.contacts.some(contact => !contact
          || typeof contact !== "object" || Array.isArray(contact)))) {
    return "malformed_whatsapp_change";
  }
  const allowed = field === "messages"
    ? ["messages", "statuses"]
    : field === "smb_message_echoes" ? ["message_echoes"] : [];
  const unexpected = ["messages", "statuses", "message_echoes"]
    .some(name => !allowed.includes(name) && value[name] !== undefined);
  if (unexpected) return "malformed_whatsapp_change";
  for (const name of allowed) {
    if (value[name] !== undefined
        && (!Array.isArray(value[name])
          || value[name].some(item => !item || typeof item !== "object"
              || Array.isArray(item)))) {
      return "malformed_whatsapp_change";
    }
  }
  if (field === "history" && value.history !== undefined
      && !Array.isArray(value.history)) return "malformed_whatsapp_change";
  if (field === "smb_app_state_sync" && value.state_sync !== undefined
      && !Array.isArray(value.state_sync)) return "malformed_whatsapp_change";
  // Passive events must not contain a disguised top-level messaging array.
  if (PASSIVE_FIELDS.has(field)) return null;

  if (!hasEvents(value, field)) return null;
  const phone = digits(value.metadata?.phone_number_id);
  const rawPhone = value.metadata?.phone_number_id;
  if (rawPhone != null && !phone) return "invalid_business_phone";
  if (phone && phone !== expectedPhone) return "different_business_phone";
  if (!phone && strictMissingMetadata) return "missing_business_phone";

  if (expectedAccount) {
    const account = digits(entry?.id);
    if (!account || account !== expectedAccount) return "different_business_account";
  }
  return null;
}

function partitionLegacyWhatsAppWebhook(body, {
  expectedPhoneNumberId,
  expectedAccountId = null,
  strictAccount = false,
  strictMissingMetadata = false,
} = {}) {
  const expected = digits(expectedPhoneNumberId);
  if (!expected) {
    throw new LegacySenderBoundaryError(
      "LEGACY_SENDER_CONFIG_MISSING",
      "WHATSAPP_PHONE_NUMBER_ID must be configured before accepting customer webhooks."
    );
  }
  const expectedAccount = strictAccount ? digits(expectedAccountId) : null;
  if (strictAccount && !expectedAccount) {
    throw new LegacySenderBoundaryError(
      "LEGACY_SENDER_ACCOUNT_CONFIG_MISSING",
      "Account-ID validation is enabled but WHATSAPP_WABA_ID is not configured."
    );
  }
  const quarantined = [];
  const entries = [];
  function add(entry, change, reason) {
    if (quarantined.length >= MAX_QUARANTINE_EVENTS) {
      throw new LegacySenderBoundaryError(
        "WHATSAPP_WEBHOOK_QUARANTINE_LIMIT",
        "Too many invalid webhook events in one payload."
      );
    }
    quarantined.push(quarantine(entry, change, reason));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) {
    add(null, { field: "invalid", value: null }, "invalid_whatsapp_webhook");
  } else if (body.entry.length > MAX_META_ENTRIES) {
    throw new LegacySenderBoundaryError("WHATSAPP_WEBHOOK_ENTRY_LIMIT", "Too many Meta entries.");
  } else {
    for (const entry of body.entry) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
          || !Array.isArray(entry.changes)) {
        add(entry, { field: "invalid_entry" }, "invalid_whatsapp_entry");
        continue;
      }
      if (entry.changes.length > MAX_CHANGE_ITEMS) {
        throw new LegacySenderBoundaryError("WHATSAPP_WEBHOOK_CHANGE_LIMIT", "Too many Meta changes.");
      }
      const accepted = [];
      for (const change of entry.changes) {
        const reason = validateChange(
          entry, change, expected, expectedAccount, strictMissingMetadata
        );
        if (reason) add(entry, change, reason);
        else accepted.push(change);
      }
      if (accepted.length) entries.push({ ...entry, changes: accepted });
    }
  }
  return {
    acceptedBody: { object: "whatsapp_business_account", entry: entries },
    quarantined,
    configured: true,
    acceptedChanges: entries.reduce((n, entry) => n + entry.changes.length, 0),
    // Passive sync has no patient turn and must not relax durable quarantine.
    acceptedActionable: entries.reduce((n, entry) => n + entry.changes.reduce(
      (count, change) => count + (ROUTABLE_FIELDS.has(change.field)
        && hasEvents(change.value, change.field) ? 1 : 0), 0
    ), 0),
  };
}

module.exports = { LegacySenderBoundaryError, partitionLegacyWhatsAppWebhook };
