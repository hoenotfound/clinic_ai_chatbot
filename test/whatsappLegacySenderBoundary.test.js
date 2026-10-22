"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { partitionLegacyWhatsAppWebhook } = require("../src/services/whatsappLegacySenderBoundary");

const NEUTRO = "100000000000001";
const ARIEL = "100000000000002";

function change(phone, message, field = "messages") {
  return {
    field,
    value: {
      metadata: phone ? { phone_number_id: phone } : {},
      ...(field === "messages"
        ? { messages: [{ id: message, from: "60135550000", type: "text", text: { body: "hello" } }] }
        : { message_echoes: [{ id: message, from: "60125550000", to: "60135550000" }] }),
    },
  };
}

function callback(changes) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "200000000000001",
      changes,
    }],
  };
}

test("unchanged verified production phone remains fully accepted", () => {
  const payload = callback([change(NEUTRO, "wamid.existing")]);
  const result = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  assert.deepEqual(result.acceptedBody, payload);
  assert.deepEqual(result.quarantined, []);
  assert.equal(result.configured, true);
});

test("Ariel inbound to shared callback never becomes an existing-number customer", () => {
  const payload = callback([change(ARIEL, "wamid.ariel")]);
  const result = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  assert.deepEqual(result.acceptedBody.entry, []);
  assert.equal(result.quarantined.length, 1);
  assert.equal(result.quarantined[0].reason, "different_business_phone");
  assert.equal(result.quarantined[0].phoneNumberId, ARIEL);
  assert.equal(result.quarantined[0].fingerprint.length, 64);
  assert.equal(JSON.stringify(result.quarantined).includes("60135550000"), false);
  assert.equal(JSON.stringify(result.quarantined).includes("hello"), false);
});

test("mixed callbacks keep Neutro events while isolating Ariel", () => {
  const existing = change(NEUTRO, "wamid.existing");
  const second = change(ARIEL, "wamid.ariel");
  const input = callback([existing, second]);
  const result = partitionLegacyWhatsAppWebhook(input, { expectedPhoneNumberId: NEUTRO });
  assert.equal(result.acceptedBody.entry.length, 1);
  assert.deepEqual(result.acceptedBody.entry[0].changes, [existing]);
  assert.equal(result.quarantined.length, 1);
  assert.deepEqual(input.entry[0].changes, [existing, second]); // not mutated
});

test("Ariel delivery receipts, staff app echoes and reactions are isolated", () => {
  const status = {
    field: "messages",
    value: {
      metadata: { phone_number_id: ARIEL },
      statuses: [{ id: "wamid.status", status: "read" }],
    },
  };
  const echo = change(ARIEL, "wamid.staff", "smb_message_echoes");
  const reaction = {
    field: "messages",
    value: {
      metadata: { phone_number_id: ARIEL },
      messages: [{ id: "wamid.emoji", type: "reaction", from: "60135550000",
        reaction: { message_id: "wamid.old", emoji: "👍" } }],
    },
  };
  const result = partitionLegacyWhatsAppWebhook(callback([status, echo, reaction]),
    { expectedPhoneNumberId: NEUTRO });
  assert.equal(result.acceptedBody.entry.length, 0);
  assert.equal(result.quarantined.length, 3);
  assert.ok(result.quarantined.every(e => e.reason === "different_business_phone"));
});

test("unsupported field is quarantined while passive history remains non-actionable", () => {
  const history = { field: "history", value: { history: [{ progress: 100 }] } };
  const unknown = { field: "experimental_event", value: {} };
  const existing = change(NEUTRO, "wamid.keep");
  const result = partitionLegacyWhatsAppWebhook(callback([history, unknown, existing]),
    { expectedPhoneNumberId: NEUTRO });
  assert.deepEqual(result.acceptedBody.entry[0].changes, [history, existing]);
  assert.deepEqual(result.quarantined.map(x => x.reason), ["unsupported_whatsapp_event"]);
});

test("missing metadata remains backward-compatible by default but can be strictly quarantined", () => {
  const payload = callback([change(null, "wamid.legacy")]);
  const compat = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  assert.equal(compat.quarantined.length, 0);
  assert.equal(compat.acceptedBody.entry.length, 1);
  const strict = partitionLegacyWhatsAppWebhook(payload, {
    expectedPhoneNumberId: NEUTRO, strictMissingMetadata: true,
  });
  assert.equal(strict.quarantined[0].reason, "missing_business_phone");
  assert.equal(strict.acceptedBody.entry.length, 0);
});

test("invalid webhook is quarantined before customer processing", () => {
  const payload = { object: "page", entry: [] };
  const result = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  assert.deepEqual(result.acceptedBody, { object: "whatsapp_business_account", entry: [] });
  assert.equal(result.quarantined[0].reason, "invalid_whatsapp_webhook");
});

test("replays produce the same durable fingerprint without retaining message content", () => {
  const payload = callback([change(ARIEL, "wamid.ariel")]);
  const a = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  const b = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  assert.equal(a.quarantined[0].fingerprint, b.quarantined[0].fingerprint);
});

test("does not silently route unknown numbers when no configured legacy sender ID is provided", () => {
  const payload = callback([change(ARIEL, "wamid.ariel")]);
  const result = partitionLegacyWhatsAppWebhook(payload);
  assert.equal(result.configured, false);
  assert.deepEqual(result.acceptedBody, payload);
  assert.deepEqual(result.quarantined, []);
  // Deployment readiness still must require WHATSAPP_PHONE_NUMBER_ID before
  // enabling sender-aware routing; this method preserves historical behavior.
});
