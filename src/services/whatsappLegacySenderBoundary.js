"use strict";

// Safety boundary for a deployment that still has ONE WhatsApp outbound sender.
// This never routes Ariel to the legacy contact/send path. Sender-aware routing
// requires a separately reviewed activation; a second phone cannot be made
// safe by simply adding it to the Meta callback subscription.
const crypto = require("node:crypto");
const ROUTABLE_FIELDS = new Set(["messages", "smb_message_echoes"]);
const PASSIVE_FIELDS = new Set(["history", "smb_app_state_sync"]);
const MAX_QUARANTINE_EVENTS = 200;

function digits(value) {
  return typeof value === "string" && /^\d+$/.test(value.trim())
    ? value.trim()
    : null;
}

function senderEvidence(entry, change) {
  return {
    phoneNumberId: digits(change?.value?.metadata?.phone_number_id),
    accountId: digits(entry?.id),
  };
}

function isActionable(change) {
  const field = change?.field;
  if (field === "smb_message_echoes") {
    return Array.isArray(change?.value?.message_echoes)
      && change.value.message_echoes.length > 0;
  }
  return field === "messages"
    && ((Array.isArray(change?.value?.messages) && change.value.messages.length > 0)
      || (Array.isArray(change?.value?.statuses) && change.value.statuses.length > 0));
}

function quarantinedChange(entry, change, reason) {
  const evidence = senderEvidence(entry, change);
  const field = typeof change?.field === "string" ? change.field.slice(0, 100) : "invalid";
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify({ account: entry?.id || null, change }))
    .digest("hex");
  return Object.freeze({
    fingerprint: digest,
    reason,
    field,
    accountId: evidence.accountId,
    phoneNumberId: evidence.phoneNumberId,
  });
}

function partitionLegacyWhatsAppWebhook(body, {
  expectedPhoneNumberId,
  strictMissingMetadata = false,
} = {}) {
  const expected = digits(expectedPhoneNumberId);
  if (!expected) {
    // Failing here rather than defaulting to another number would interrupt
    // an existing deployment if its credentials were misconfigured. Instead,
    // startup/deployment readiness must ensure this ID exists. Never activate
    // multi-number mode when expectedPhoneNumberId is absent.
    return { acceptedBody: body, quarantined: [], configured: false };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
      || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) {
    return {
      acceptedBody: { object: "whatsapp_business_account", entry: [] },
      quarantined: [quarantinedChange(null, { field: "invalid", value: body || null },
        "invalid_whatsapp_webhook")],
      configured: true,
    };
  }
  const quarantined = [];
  const entries = [];
  for (const entry of body.entry) {
    if (!entry || !Array.isArray(entry.changes)) {
      quarantined.push(quarantinedChange(entry, { field: "invalid_entry" }, "invalid_whatsapp_entry"));
      continue;
    }
    const accepted = [];
    for (const change of entry.changes) {
      const field = change?.field;
      const action = isActionable(change);
      const { phoneNumberId } = senderEvidence(entry, change);
      const rawPhoneNumberId = change?.value?.metadata?.phone_number_id;
      const suppliedInvalidPhoneId = rawPhoneNumberId !== null
        && rawPhoneNumberId !== undefined && !phoneNumberId;
      let reason = null;
      if (field && !ROUTABLE_FIELDS.has(field) && !PASSIVE_FIELDS.has(field)) {
        reason = "unsupported_whatsapp_event";
      } else if (ROUTABLE_FIELDS.has(field) && action && suppliedInvalidPhoneId) {
        reason = "invalid_business_phone";
      } else if (ROUTABLE_FIELDS.has(field) && action && phoneNumberId && phoneNumberId !== expected) {
        reason = "different_business_phone";
      } else if (ROUTABLE_FIELDS.has(field) && action && strictMissingMetadata && !phoneNumberId) {
        reason = "missing_business_phone";
      } else if (!change || typeof change !== "object" || !change.value
                 || typeof change.value !== "object" || Array.isArray(change.value)) {
        reason = "malformed_whatsapp_change";
      }
      if (reason) {
        quarantined.push(quarantinedChange(entry, change, reason));
        if (quarantined.length > MAX_QUARANTINE_EVENTS) {
          throw new Error("WhatsApp webhook has too many quarantined events.");
        }
        continue;
      }
      accepted.push(change);
    }
    if (accepted.length) entries.push({ ...entry, changes: accepted });
  }
  return {
    acceptedBody: { ...body, entry: entries },
    quarantined,
    configured: true,
  };
}

module.exports = {
  partitionLegacyWhatsAppWebhook,
};
