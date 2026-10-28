const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSenderRegistry,
  inspectWhatsAppWebhookSenders,
  resolveWhatsAppSender,
  validateWhatsAppWebhookSenders,
  conversationKeyForSender,
} = require("../src/services/whatsappSenderRouting");

const existing = {
  key: "neutro",
  phoneNumberId: "100000000000001",
  accountId: "200000000000001",
  displayName: "Neutro Sense TCM",
  state: "active",
  coexistenceEnabled: false,
};
const ariel = {
  key: "ariel",
  phoneNumberId: "100000000000002",
  accountId: "200000000000002",
  displayName: "Ariel Lee",
  state: "testing",
  coexistenceEnabled: true,
};

function batch() {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: existing.accountId,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: existing.phoneNumberId },
          messages: [{ id: "wamid.old", from: "60135550000", type: "text" }],
        },
      }],
    }, {
      id: ariel.accountId,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: ariel.phoneNumberId },
          messages: [{ id: "wamid.ariel", from: "60135550000", type: "text" }],
        },
      }, {
        field: "smb_message_echoes",
        value: {
          metadata: { phone_number_id: ariel.phoneNumberId },
          message_echoes: [{ id: "wamid.staff", to: "60135550000" }],
        },
      }],
    }],
  };
}

test("same customer on different senders remains two distinct conversation identities", () => {
  assert.notEqual(
    conversationKeyForSender("neutro", "60135550000"),
    conversationKeyForSender("ariel", "60135550000")
  );
});

test("registry refuses duplicate phone identities and duplicate keys", () => {
  assert.throws(
    () => createSenderRegistry([existing, { ...ariel, phoneNumberId: existing.phoneNumberId }]),
    (err) => err.code === "WHATSAPP_SENDER_DUPLICATE"
  );
  assert.throws(
    () => createSenderRegistry([existing, { ...ariel, key: existing.key }]),
    (err) => err.code === "WHATSAPP_SENDER_DUPLICATE"
  );
});

test("sender records do not include any token or authorization secret", () => {
  const registry = createSenderRegistry([
    { ...existing, token: "top-secret", appSecret: "secret" },
  ]);
  const sender = registry.findByPhoneNumberId(existing.phoneNumberId);
  assert.equal(sender.token, undefined);
  assert.equal(sender.appSecret, undefined);
  assert.equal(sender.coexistenceEnabled, false);
});

test("two-number webhook preserves account and receiving-phone provenance", () => {
  const events = inspectWhatsAppWebhookSenders(batch());
  assert.deepEqual(events, [
    { accountId: existing.accountId, phoneNumberId: existing.phoneNumberId, eventCount: 1 },
    { accountId: ariel.accountId, phoneNumberId: ariel.phoneNumberId, eventCount: 1 },
    { accountId: ariel.accountId, phoneNumberId: ariel.phoneNumberId, eventCount: 1 },
  ]);
});

test("disabled or testing sender cannot be used for live routing", () => {
  const registry = createSenderRegistry([existing, ariel]);
  assert.throws(
    () => validateWhatsAppWebhookSenders(batch(), registry),
    (err) => err.code === "WHATSAPP_SENDER_DISABLED"
  );
  assert.throws(
    () => validateWhatsAppWebhookSenders(batch(), registry, { allowTesting: true }),
    (err) => err.code === "WHATSAPP_SENDER_DISABLED"
  );
  const inspection = inspectWhatsAppWebhookSenders(batch());
  assert.equal(inspection.length, 3); // Inspect-only; this never authorizes customer processing.
  const activeRegistry = createSenderRegistry([existing, { ...ariel, state: "active" }]);
  const result = validateWhatsAppWebhookSenders(batch(), activeRegistry);
  assert.deepEqual(result.resolved.map((sender) => sender.key), [
    "neutro", "ariel", "ariel",
  ]);
});

test("unknown phone or mismatched WhatsApp account fails closed", () => {
  const registry = createSenderRegistry([existing, { ...ariel, state: "active" }]);
  assert.throws(
    () => resolveWhatsAppSender({
      accountId: existing.accountId,
      phoneNumberId: ariel.phoneNumberId,
    }, registry),
    (err) => err.code === "WHATSAPP_SENDER_NOT_AUTHORIZED"
  );
  const events = batch();
  events.entry[1].changes[0].value.metadata.phone_number_id = "999999999";
  assert.throws(
    () => validateWhatsAppWebhookSenders(events, registry),
    (err) => err.code === "WHATSAPP_SENDER_NOT_AUTHORIZED"
  );
});

test("missing receiving phone metadata never defaults to old sender", () => {
  const registry = createSenderRegistry([existing]);
  const payload = batch();
  delete payload.entry[0].changes[0].value.metadata;
  assert.throws(
    () => validateWhatsAppWebhookSenders(payload, registry),
    (err) => err.code === "WHATSAPP_SENDER_PHONE_ID_INVALID"
  );
});

test("status callbacks are sender-aware and passive sync does not become an inbound customer turn", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: ariel.accountId,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: ariel.phoneNumberId },
          statuses: [{ id: "wamid.sent", status: "delivered" }],
        },
      }, {
        field: "history",
        value: { history: [{ progress: 100 }] },
      }],
    }],
  };
  assert.deepEqual(inspectWhatsAppWebhookSenders(payload), [{
    accountId: ariel.accountId,
    phoneNumberId: ariel.phoneNumberId,
    eventCount: 1,
  }]);
  const result = validateWhatsAppWebhookSenders(payload, createSenderRegistry([
    { ...ariel, state: "active" },
  ]));
  assert.deepEqual(result.passive, [{
    accountId: ariel.accountId, field: "history",
  }]);
});

test("empty webhook does not manufacture a sender or start an AI conversation", () => {
  const result = validateWhatsAppWebhookSenders({
    object: "whatsapp_business_account", entry: [],
  }, createSenderRegistry([]));
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.resolved, []);
});

test("normalized WhatsApp events preserve the receiving number without changing old event shapes", () => {
  const whatsapp = require("../src/services/whatsappService");
  const payload = {
    entry: [{
      id: ariel.accountId,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: ariel.phoneNumberId },
          contacts: [{ wa_id: "60135550000", profile: { name: "Customer" } }],
          messages: [{
            id: "wamid.inbound", from: "60135550000",
            type: "text", text: { body: "Hi" },
          }, {
            id: "wamid.reaction", from: "60135550000",
            type: "reaction", reaction: {
              message_id: "wamid.previous", emoji: "👍",
            },
          }],
          statuses: [{
            id: "wamid.outbound", status: "delivered",
          }],
        },
      }, {
        field: "smb_message_echoes",
        value: {
          metadata: { phone_number_id: ariel.phoneNumberId },
          message_echoes: [{
            id: "wamid.staff", from: "60122972817",
            to: "60135550000", type: "text", text: { body: "Hello" },
          }],
        },
      }],
    }],
  };
  for (const parser of [
    whatsapp.parseIncomingMessages,
    whatsapp.parseReactionEvents,
    whatsapp.parseStatusUpdates,
    whatsapp.parseBusinessAppEchoes,
  ]) {
    const [event] = parser(payload);
    assert.equal(event.businessPhoneNumberId, ariel.phoneNumberId);
    assert.equal(event.businessAccountId, ariel.accountId);
  }

  const legacy = {
    entry: [{ changes: [{ value: {
      messages: [{ id: "wamid.legacy", from: "60135550000", type: "text", text: { body: "Hi" } }],
    } }] }],
  };
  assert.equal("businessPhoneNumberId" in whatsapp.parseIncomingMessages(legacy)[0], false);
});

test("sender-scoped customer keys reuse canonical Malaysian phone normalization", () => {
  const { normalizeWhatsappNumber } = require("../src/db/contactsRepo");
  const variants = ["012-345 6789", "60123456789", "+60 12 345 6789",
    "0060 12 345 6789", "+60 (012) 345-6789", "123456789"];
  const values = variants.map((phone) => conversationKeyForSender("ariel", phone));
  assert.equal(new Set(values).size, 1);
  assert.equal(values[0], "whatsapp:ariel:60123456789");
  assert.equal(normalizeWhatsappNumber("012-345 6789"), "60123456789");
  assert.notEqual(conversationKeyForSender("neutro", variants[0]), values[0]);
});

test("sender and customer identity refuses invalid keys and phone data", () => {
  for (const [key, phone] of [
    ["ARIEL", "60123456789"], ["bad/key", "60123456789"],
    ["ariel", "hello60123456789"], ["ariel", ""],
    ["ariel", "0123"], ["ariel", "12345678901234567"],
  ]) {
    assert.throws(
      () => conversationKeyForSender(key, phone),
      (err) => ["WHATSAPP_CONVERSATION_IDENTITY_INVALID", "WHATSAPP_SENDER_KEY_INVALID"].includes(err.code)
    );
  }
});

test("sender registry lookup is immutable; Map mutation is not exposed", () => {
  const registry = createSenderRegistry([existing, ariel]);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal("byPhone" in registry, false);
  assert.equal("byKey" in registry, false);
  const original = registry.findByPhoneNumberId(existing.phoneNumberId);
  assert.equal(Object.isFrozen(original), true);
  assert.equal(registry.findByKey("neutro"), original);
  assert.equal(registry.findByPhoneNumberId("9999"), null);
  assert.throws(() => {
    Object.defineProperty(registry, "findByPhoneNumberId", {
      value: () => ariel,
    });
  }, TypeError);
  assert.throws(
    () => resolveWhatsAppSender({
      accountId: existing.accountId, phoneNumberId: existing.phoneNumberId,
    }, { ...registry }),
    (err) => err.code === "WHATSAPP_SENDER_REGISTRY_UNAVAILABLE"
  );
  assert.equal(registry.findByPhoneNumberId(existing.phoneNumberId), original);
});

test("testing sender never authorizes live routing even with caller-provided bypass", () => {
  const registry = createSenderRegistry([existing, ariel]);
  const event = { accountId: ariel.accountId, phoneNumberId: ariel.phoneNumberId };
  assert.equal(registry.findByPhoneNumberId(ariel.phoneNumberId).state, "testing");
  for (const options of [{ allowTesting: true }, { deploymentMode: "test" }, undefined]) {
    assert.throws(
      () => resolveWhatsAppSender(event, registry, options),
      (err) => err.code === "WHATSAPP_SENDER_DISABLED"
    );
  }
});

test("invalid webhook type, malformed changes, and unrecognized fields fail closed", () => {
  const registry = createSenderRegistry([existing, { ...ariel, state: "active" }]);
  const malformed = [
    { entry: [] },
    { object: "page", entry: [] },
    { object: "whatsapp_business_account", entry: [{}] },
    { object: "whatsapp_business_account", entry: [{
      id: ariel.accountId, changes: [{ field: "messages", value: {
        metadata: { phone_number_id: ariel.phoneNumberId }, messages: "not an array",
      } }],
    }] },
  ];
  for (const payload of malformed) {
    assert.throws(
      () => validateWhatsAppWebhookSenders(payload, registry),
      (err) => err.code === "WHATSAPP_WEBHOOK_INVALID"
    );
  }
  const unsupported = batch();
  unsupported.entry[1].changes.push({
    field: "future_unknown_status",
    value: { metadata: { phone_number_id: ariel.phoneNumberId }, messages: [
      { id: "wamid.injected", from: "60135550000" },
    ] },
  });
  assert.throws(
    () => validateWhatsAppWebhookSenders(unsupported, registry),
    (err) => err.code === "WHATSAPP_WEBHOOK_UNSUPPORTED_CHANGE"
  );
});

test("passive Business App sync cannot create routable conversations", () => {
  const registry = createSenderRegistry([existing]);
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ id: ariel.accountId, changes: [
      { field: "history", value: { history: [{ progress: 100 }] } },
      { field: "smb_app_state_sync", value: { state_sync: [{ type: "contact" }] } },
    ] }],
  };
  const result = validateWhatsAppWebhookSenders(payload, registry);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.passive, [
    { accountId: ariel.accountId, field: "history" },
    { accountId: ariel.accountId, field: "smb_app_state_sync" },
  ]);
});

test("passive sync also requires verified Meta account provenance", () => {
  const registry = createSenderRegistry([existing]);
  const invalid = {
    object: "whatsapp_business_account",
    entry: [{ id: "not-a-meta-account", changes: [
      { field: "history", value: { history: [{ progress: 100 }] } },
    ] }],
  };
  assert.throws(
    () => validateWhatsAppWebhookSenders(invalid, registry),
    (err) => err.code === "WHATSAPP_SENDER_ACCOUNT_ID_INVALID"
  );
});
