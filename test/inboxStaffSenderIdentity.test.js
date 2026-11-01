"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../src/routes/conversations"), "utf8");

function harness(sender = "primary") {
  const routeStart = source.indexOf('router.post("/:contactId/messages",');
  const routeEnd = source.indexOf("\nfunction handleImageUpload(", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const calls = [];
  let handler;
  const contact = {
    id: 8865, channel: "whatsapp", mode: "ai",
    whatsapp_sender_id: sender === "legacy" ? null : (sender === "primary" ? 1 : 2),
    whatsapp_sender_key: sender === "primary" ? "neutro" :
      sender === "secondary" ? "neutro_secondary" : undefined,
    whatsapp_sender_phone_number_id: sender === "primary" ? "1408739622311791" :
      sender === "secondary" ? "1318355951360575" : undefined,
  };
  const sandbox = {
    router: { post(path, fn) { assert.equal(path, "/:contactId/messages"); handler = fn; } },
    process: { env: { WHATSAPP_PRIMARY_SENDER_KEY: "neutro" } },
    console: { error: error => { throw error; } },
    contactsRepo: {
      getContactById: async () => contact,
      setDeliveryAttention: async () => { calls.push("attention"); },
    },
    resolveReplyTarget: async () => ({ ok: true, target: null }),
    requireFreeformPolicy: async () => true,
    whatsappPolicy: { manualStaffPurpose: () => "service" },
    telegramImmediateAlertRepo: { withContactAlertLock: async (_, fn) => fn() },
    prepareStaffSend: async () => contact,
    conversationStore: { appendMessageForContact: async () => ({ id: 16213, contact_id: 8865 }) },
    // This is the real database-return shape from an attention clear/update.
    // It drops the JOIN-derived whatsapp_sender_key and phone/account IDs.
    finalizeStaffSendState: async () => {
      calls.push("finalize");
      return { id: 8865, channel: "whatsapp", whatsapp_sender_id: contact.whatsapp_sender_id, needs_attention: false };
    },
    channelMessaging: {
      sendText: async (c, text) => {
        calls.push("primary");
        assert.equal(c.whatsapp_sender_key, sender === "legacy" ? undefined : "neutro");
        assert.equal(text, "Forward错了对不起哦");
        return { success: true, wamid: "wamid.primary" };
      },
    },
    sendSecondaryStaffText: async ({ contact: c }) => {
      calls.push("secondary");
      assert.equal(c.whatsapp_sender_key, sender === "secondary" ? "neutro_secondary" : undefined);
      return { success: false, retryable: false, error: "secondary blocked" };
    },
    socialProviderSendOptions: () => ({}),
    deliveryErrorForSend: (result, error) => result.success ? null : error,
    rejectedErrorFor: () => "rejected",
    persistSendOutcome: async (saved, result, error) => ({
      ...saved, delivery_status: result.success ? "sent" : "failed", delivery_error: error,
    }),
    publicDeliveryError: error => error,
    reconcileAcceptedStaffReplyAttention: async () => { calls.push("reconcile"); },
    markLeadContacted: async () => { calls.push("lead"); },
    recordStaffConfirmedBooking: async () => null,
  };
  vm.runInNewContext(source.slice(routeStart, routeEnd), sandbox);
  return {
    calls,
    async send() {
      let status, body;
      const res = {
        status(value) { status = value; return this; },
        json(value) { body = value; return this; },
      };
      await handler(
        { params: { contactId: "8865" }, session: { username: "admin" }, body: { text: "Forward错了对不起哦" } },
        res,
      );
      return { status, body };
    },
  };
}

test("Booking Ready staff text retains verified PRIMARY sender after attention update", async () => {
  const h = harness("primary");
  const result = await h.send();
  assert.equal(result.status, 201);
  assert.equal(result.body.delivered, true);
  assert.deepEqual(h.calls, ["finalize", "primary", "reconcile", "lead"]);
});

test("staff message from real SECONDARY never falls through to primary when disabled", async () => {
  const h = harness("secondary");
  const result = await h.send();
  assert.equal(result.status, 201);
  assert.equal(result.body.delivered, false);
  assert.deepEqual(h.calls, ["finalize", "secondary", "attention"]);
});

test("missing sender key on a scoped contact still fails closed, not primary", async () => {
  const h = harness("unverified");
  const result = await h.send();
  assert.equal(result.status, 201);
  assert.equal(result.body.delivered, false);
  assert.deepEqual(h.calls, ["finalize", "secondary", "attention"]);
});

test("unscoped legacy primary staff message preserves original transport", async () => {
  const h = harness("legacy");
  const result = await h.send();
  assert.equal(result.status, 201);
  assert.equal(result.body.delivered, true);
  assert.deepEqual(h.calls, ["finalize", "primary", "reconcile", "lead"]);
});

test("primary staff template also keeps verified sender across attention state changes", () => {
  const start = source.indexOf('router.post("/:contactId/whatsapp-templates/send"');
  const end = source.indexOf("\nrouter.post(", start + 1);
  assert.ok(start >= 0 && end > start, "manual template route must exist");
  const text = source.slice(start, end);
  assert.match(text, /await finalizeStaffSendState\(preparedContact\.id, req\.session\.username\);\s*return \{ preparedContact, saved \};/);
  assert.doesNotMatch(text, /return \{ preparedContact: finalContact \|\| preparedContact, saved \}/);
});
