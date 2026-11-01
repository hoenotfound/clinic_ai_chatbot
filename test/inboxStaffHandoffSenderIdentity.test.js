"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const routeSource = fs.readFileSync(require.resolve("../src/routes/conversations"), "utf8");
const ownershipSource = fs.readFileSync(require.resolve("../src/services/staffOwnershipService"), "utf8");

function handoffHarness({ sender = "primary", handoffDuringFinalization = false, loseContactAfterClaim = false } = {}) {
  const events = [];
  let handler, claims = 0, reads = 0;
  const owner = "AI_HANDOFF";
  const state = {
    id: 8865, channel: "whatsapp", whatsapp_number: "60173121614",
    whatsapp_sender_id: sender === "legacy" ? null : sender === "primary" ? 1 : 2,
    mode: handoffDuringFinalization ? "ai" : "human",
    takeover_by: handoffDuringFinalization ? null : owner,
    needs_attention: true, is_unread: true,
  };
  const senderFields = sender === "secondary" ?
    { whatsapp_sender_key: "neutro_secondary", whatsapp_sender_phone_number_id: "1318355951360575",
      whatsapp_sender_account_id: "1852014482431209" } :
    sender === "primary" ?
    { whatsapp_sender_key: "neutro", whatsapp_sender_phone_number_id: "1408739622311791",
      whatsapp_sender_account_id: "1593376338308612" } : {};
  const verified = () => ({ ...state, ...senderFields });
  const bareRow = () => ({ ...state }); // Matches SQL UPDATE contacts ... RETURNING contacts.*
  const sandbox = {
    console: { error() {} },
    process: { env: { WHATSAPP_PRIMARY_SENDER_KEY: "neutro" } },
    CONVERSATION_LOCK_NAMESPACE: 240101,
    AI_HANDOFF_OWNER: owner,
    router: { post(path, callback) {
      assert.equal(path, "/:contactId/messages");
      handler = callback;
    }},
    aiReplyCancellation: { cancelForContact() { events.push("cancel-ai"); } },
    ownershipDatabase: {
      async query(sql, args) {
        assert.match(sql, /UPDATE contacts c/);
        assert.match(sql, /SELECT takeover\.\*/);
        assert.equal(args[1], state.id);
        claims++;
        if (state.mode !== "human" || state.takeover_by !== owner) return { rows: [] };
        state.takeover_by = args[0];
        return { rows: [bareRow()] };
      },
    },
    publishOwner() { events.push("ownership-published"); },
    contactsRepo: {
      async getContactById(id) {
        assert.equal(Number(id), state.id);
        reads++;
        if (loseContactAfterClaim && claims > 0) return null;
        return verified(); // the repository restores sender identity with a joined lookup
      },
      async clearStaffAssistStateIfUnchanged(contact) {
        assert.equal(contact.whatsapp_sender_key, senderFields.whatsapp_sender_key);
        events.push("attention-cleared");
        state.needs_attention = false;
        state.is_unread = false;
        return bareRow(); // UPDATE also strips sender fields
      },
      async setDeliveryAttention() { events.push("delivery-attention"); },
    },
    resolveReplyTarget: async () => ({ ok: true, target: null }),
    requireFreeformPolicy: async () => true,
    whatsappPolicy: { manualStaffPurpose: () => "service" },
    telegramImmediateAlertRepo: { withContactAlertLock: async (_, cb) => cb() },
    conversationStore: {
      appendMessageForContact: async () => {
        events.push("saved");
        if (handoffDuringFinalization) {
          state.mode = "human";
          state.takeover_by = owner;
        }
        return { id: 5001, contact_id: state.id };
      },
    },
    channelMessaging: {
      async sendText(contact) {
        events.push("primary-send");
        assert.equal(contact.whatsapp_sender_key, senderFields.whatsapp_sender_key);
        assert.notEqual(sender, "secondary", "secondary must never route through primary");
        return { success: true, wamid: "wamid.primary" };
      },
    },
    async sendSecondaryStaffText({ contact }) {
      events.push("secondary-blocked");
      assert.equal(contact.whatsapp_sender_key, "neutro_secondary");
      return { success: false, retryable: false, policyBlocked: true, error: "Secondary staff sends disabled." };
    },
    socialProviderSendOptions: () => ({}),
    deliveryErrorForSend: (result, error) => result.success ? null : error,
    rejectedErrorFor: () => "rejected",
    persistSendOutcome: async (saved, result, error) => ({
      ...saved, delivery_status: result.success ? "sent" : "failed", delivery_error: error,
    }),
    publicDeliveryError: error => error,
    reconcileAcceptedStaffReplyAttention: async () => {},
    markLeadContacted: async () => {},
    recordStaffConfirmedBooking: async () => null,
  };
  vm.createContext(sandbox);
  const ownerStart = ownershipSource.indexOf("function createStaffOwnershipService(");
  const ownerEnd = ownershipSource.indexOf("\nconst claimAiHandoffOwnership =", ownerStart);
  assert.ok(ownerStart >= 0 && ownerEnd > ownerStart);
  vm.runInContext(ownershipSource.slice(ownerStart, ownerEnd), sandbox);
  sandbox.claimAiHandoffOwnership = vm.runInContext(
    "createStaffOwnershipService({ database: ownershipDatabase, publish: publishOwner })", sandbox
  );
  const helperStart = routeSource.indexOf("async function prepareStaffSend(");
  const helperEnd = routeSource.indexOf("async function persistSendOutcome(", helperStart);
  const routeStart = routeSource.indexOf('router.post("/:contactId/messages",');
  const routeEnd = routeSource.indexOf("\nfunction handleImageUpload(", routeStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  vm.runInContext(routeSource.slice(helperStart, helperEnd) + "\n" +
    routeSource.slice(routeStart, routeEnd), sandbox);
  return {
    events, state,
    get claims() { return claims; },
    get reads() { return reads; },
    async send() {
      let status, body;
      const response = { status(n) { status = n; return this; }, json(value) { body = value; return this; } };
      await handler({
        params: { contactId: String(state.id) },
        body: { text: "Following up about your appointment" },
        session: { username: "staff" },
      }, response);
      return { status, body };
    },
    finalize: () => sandbox.finalizeStaffSendState(state.id, "staff"),
  };
}

test("real staff handover code returns verified PRIMARY sender before sending", async () => {
  const h = handoffHarness();
  const outcome = await h.send();
  assert.equal(outcome.status, 201);
  assert.equal(outcome.body.delivered, true);
  assert.equal(h.claims, 1);
  assert.equal(h.state.takeover_by, "staff");
  assert.ok(h.reads >= 4, "handover and attention updates must re-read sender");
  assert.equal(h.events.filter(x => x === "primary-send").length, 1);
  assert.equal(h.events.includes("secondary-blocked"), false);
});

test("a handover arising after saving the staff message still keeps the PRIMARY sender", async () => {
  const h = handoffHarness({ handoffDuringFinalization: true });
  const outcome = await h.send();
  assert.equal(outcome.status, 201);
  assert.equal(outcome.body.delivered, true);
  assert.equal(h.claims, 1);
  assert.ok(h.events.includes("attention-cleared"));
  assert.equal(h.events.filter(x => x === "primary-send").length, 1);
});

test("SECONDARY handover cannot fall through to the primary WhatsApp client", async () => {
  const h = handoffHarness({ sender: "secondary" });
  const result = await h.send();
  assert.equal(result.status, 201);
  assert.equal(result.body.delivered, false);
  assert.equal(h.claims, 1);
  assert.equal(h.events.includes("primary-send"), false);
  assert.equal(h.events.filter(x => x === "secondary-blocked").length, 1);
});

test("failure to verify a claimed sender prevents any provider send", async () => {
  const h = handoffHarness({ loseContactAfterClaim: true });
  const result = await h.send();
  assert.equal(result.status, 500);
  assert.equal(h.events.includes("primary-send"), false);
  assert.equal(h.events.includes("secondary-blocked"), false);
});

test("Staff Assist clear returns sender-aware contact for media and forwarding routes", async () => {
  const h = handoffHarness();
  const contact = await h.finalize();
  assert.equal(contact.whatsapp_sender_key, "neutro");
  assert.equal(contact.whatsapp_sender_account_id, "1593376338308612");
  assert.equal(contact.needs_attention, false);
  assert.equal(h.events.includes("attention-cleared"), true);
});
