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

test("explicitly malformed business sender metadata never falls back to Neutro", () => {
  const payload = callback([change(ARIEL, "wamid.bad")]);
  payload.entry[0].changes[0].value.metadata.phone_number_id = "not-a-valid-phone-id";
  const result = partitionLegacyWhatsAppWebhook(payload, {
    expectedPhoneNumberId: NEUTRO,
  });
  assert.deepEqual(result.acceptedBody.entry, []);
  assert.equal(result.quarantined[0].reason, "invalid_business_phone");
});

test("legacy safety checks are positioned before the durable webhook claims", () => {
  const fs = require("node:fs");
  const code = fs.readFileSync(require.resolve("../src/createApp"), "utf8");
  const start = code.indexOf('app.post("/webhook", webhookJsonParser');
  const boundary = code.indexOf("partitionLegacyWhatsAppWebhook(req.body", start);
  const durableAudit = code.indexOf("await recordQuarantinedWhatsAppChanges", start);
  const parse = code.indexOf("whatsapp.parseIncomingMessages(webhookBody)", start);
  const durableClaim = code.indexOf("await durablyClaimIncoming(", start);
  const ack = code.indexOf("res.sendStatus(200)", start);
  const mixedAudit = code.indexOf("void recordQuarantinedWhatsAppChanges", ack);
  assert.ok(start >= 0 && start < boundary && boundary < durableAudit
    && durableAudit < parse && parse < durableClaim && durableClaim < ack
    && ack < mixedAudit);
  assert.match(code.slice(start, ack), /if \(quarantineOnly\)/);
});

test("replays produce the same durable fingerprint without retaining message content", () => {
  const payload = callback([change(ARIEL, "wamid.ariel")]);
  const a = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  const b = partitionLegacyWhatsAppWebhook(payload, { expectedPhoneNumberId: NEUTRO });
  assert.equal(a.quarantined[0].fingerprint, b.quarantined[0].fingerprint);
});

test("missing legacy phone configuration fails closed instead of accepting an unknown sender", () => {
  assert.throws(
    () => partitionLegacyWhatsAppWebhook(callback([change(ARIEL, "wamid.ariel")])),
    err => err.code === "LEGACY_SENDER_CONFIG_MISSING"
  );
});

test("strict account ownership rejects a different Meta account even on the same phone ID", () => {
  const payload = callback([change(NEUTRO, "wamid.account-mismatch")]);
  const result = partitionLegacyWhatsAppWebhook(payload, {
    expectedPhoneNumberId: NEUTRO,
    expectedAccountId: "200000000000002",
    strictAccount: true,
  });
  assert.equal(result.acceptedBody.entry.length, 0);
  assert.equal(result.quarantined[0].reason, "different_business_account");
  assert.throws(
    () => partitionLegacyWhatsAppWebhook(payload, {
      expectedPhoneNumberId: NEUTRO, strictAccount: true,
    }),
    err => err.code === "LEGACY_SENDER_ACCOUNT_CONFIG_MISSING"
  );
});

test("malformed arrays, incorrect field types, and disguised passive messages are isolated", () => {
  const good = change(NEUTRO, "wamid.good");
  const mixed = callback([
    { field: "messages", value: {
      metadata: { phone_number_id: NEUTRO },
      messages: "not-an-array",
    } },
    { field: "history", value: {
      history: [], messages: [{ id: "wamid.injected", from: "60135550000" }],
    } },
    { field: "smb_app_state_sync", value: {
      state_sync: [], statuses: [{ id: "wamid.fake", status: "read" }],
    } },
    { field: "smb_message_echoes", value: {
      metadata: { phone_number_id: NEUTRO },
      message_echoes: "wrong-type",
    } },
    { field: "messages", value: { messages: [null] } },
    good,
  ]);
  const result = partitionLegacyWhatsAppWebhook(mixed, { expectedPhoneNumberId: NEUTRO });
  assert.deepEqual(result.acceptedBody.entry[0].changes, [good]);
  assert.equal(result.quarantined.length, 5);
  assert.ok(result.quarantined.every(item => item.reason === "malformed_whatsapp_change"));
});

test("invalid contacts or metadata cannot make a valid message disappear inside parser error handling", () => {
  const malformedContacts = change(NEUTRO, "wamid.bad-contacts");
  malformedContacts.value.contacts = "incorrect-type";
  const malformedMeta = change(NEUTRO, "wamid.bad-metadata");
  malformedMeta.value.metadata = ["not-an-object"];
  const good = change(NEUTRO, "wamid.good");
  const r = partitionLegacyWhatsAppWebhook(
    callback([malformedContacts, malformedMeta, good]),
    { expectedPhoneNumberId: NEUTRO }
  );
  assert.deepEqual(r.acceptedBody.entry[0].changes, [good]);
  assert.deepEqual(r.quarantined.map(x => x.reason), [
    "malformed_whatsapp_change", "malformed_whatsapp_change",
  ]);
});

test("unknown field with a top-level messages list is quarantined", () => {
  const unknown = change(NEUTRO, "wamid.hijack");
  unknown.field = "experimental";
  const result = partitionLegacyWhatsAppWebhook(callback([unknown]), {
    expectedPhoneNumberId: NEUTRO,
  });
  assert.deepEqual(result.acceptedBody.entry, []);
  assert.equal(result.quarantined[0].reason, "unsupported_whatsapp_event");
});

test("foreign-only and mixed events return correct audit classification", () => {
  const foreign = partitionLegacyWhatsAppWebhook(callback([change(ARIEL, "wamid.ariel")]), {
    expectedPhoneNumberId: NEUTRO,
  });
  assert.equal(foreign.acceptedChanges, 0);
  const mixed = partitionLegacyWhatsAppWebhook(callback([
    change(ARIEL, "wamid.ariel"), change(NEUTRO, "wamid.neutro"),
  ]), { expectedPhoneNumberId: NEUTRO });
  assert.equal(mixed.acceptedChanges, 1);
  assert.equal(mixed.acceptedActionable, 1);
  assert.equal(mixed.quarantined.length, 1);
});

test("passive history plus foreign messages cannot downgrade durable quarantine to best effort", () => {
  const history = { field: "history", value: { history: [] } };
  const r = partitionLegacyWhatsAppWebhook(
    callback([history, change(ARIEL, "wamid.ariel")]),
    { expectedPhoneNumberId: NEUTRO }
  );
  assert.equal(r.acceptedChanges, 1);
  assert.equal(r.acceptedActionable, 0);
  assert.equal(r.quarantined.length, 1);
});
