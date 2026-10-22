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
  phoneNumberId: "1408739622311791",
  accountId: "2096503054342118",
  displayName: "Neutro Sense TCM",
  state: "active",
  coexistenceEnabled: false,
};
const ariel = {
  key: "ariel",
  phoneNumberId: "110552088553929",
  accountId: "758291387233325",
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
  const sender = registry.byPhone.get(existing.phoneNumberId);
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
  const result = validateWhatsAppWebhookSenders(batch(), registry, { allowTesting: true });
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
});

test("empty webhook does not manufacture a sender or start an AI conversation", () => {
  const result = validateWhatsAppWebhookSenders({ entry: [] }, createSenderRegistry([]));
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
  assert.equal(whatsapp.parseIncomingMessages(payload)[0].businessPhoneNumberId, ariel.phoneNumberId);
  assert.equal(whatsapp.parseReactionEvents(payload)[0].businessPhoneNumberId, ariel.phoneNumberId);
  assert.equal(whatsapp.parseStatusUpdates(payload)[0].businessPhoneNumberId, ariel.phoneNumberId);
  assert.equal(whatsapp.parseBusinessAppEchoes(payload)[0].businessPhoneNumberId, ariel.phoneNumberId);

  const legacy = {
    entry: [{ changes: [{ value: {
      messages: [{ id: "wamid.legacy", from: "60135550000", type: "text", text: { body: "Hi" } }],
    } }] }],
  };
  assert.equal("businessPhoneNumberId" in whatsapp.parseIncomingMessages(legacy)[0], false);
});
