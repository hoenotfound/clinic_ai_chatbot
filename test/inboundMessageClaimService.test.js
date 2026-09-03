const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageClaimService,
} = require("../src/services/inboundMessageClaimService");

function makeService({ duplicate = false, policy = undefined } = {}) {
  const calls = [];
  const contacts = {
    async getOrCreateContact(from, profileName) {
      calls.push(["contact", from, profileName]);
      return { id: 42, mode: "ai", channel: "whatsapp" };
    },
    async getOrCreateChannelContact() {
      throw new Error("unexpected social contact path");
    },
    async setUnread(id, unread) {
      calls.push(["unread", id, unread]);
    },
    async setAttention(id, needsAttention, reason) {
      calls.push(["attention", id, needsAttention, reason]);
    },
  };
  const store = {
    async appendInboundMessageIfNew(contactId, content, messageId) {
      calls.push(["claim", contactId, content, messageId]);
      return duplicate ? null : { id: 777, contact_id: contactId, content };
    },
  };
  const pipeline = {
    async ensureLeadForContact(contactId, actor, messageId) {
      calls.push(["lead", contactId, actor, messageId]);
      return { id: 9 };
    },
  };
  const messages = {
    async getMessagePageForContact(contactId) {
      calls.push(["first-message", contactId]);
      return { rows: [{ id: 777 }], hasMore: false };
    },
  };

  return {
    calls,
    claim: createInboundMessageClaimService({
      contacts,
      store,
      pipeline,
      messages,
      ...(policy ? { policy } : {}),
    }),
  };
}

test("durably claims the inbound message before unread/lead/debounce bookkeeping", async () => {
  const { calls, claim } = makeService();
  const result = await claim({
    id: "wamid-1",
    from: "60123456789",
    profileName: "Patient",
    text: "how much hifu",
    channel: "whatsapp",
  });

  assert.equal(result.savedInbound.id, 777);
  assert.equal(result.wasFirstMessage, true);
  assert.equal(calls[1][0], "claim");
  assert.deepEqual(calls.slice(2).map((call) => call[0]), ["unread", "lead", "first-message"]);
});

test("duplicate webhook claims stop before any later side effects", async () => {
  const { calls, claim } = makeService({ duplicate: true });
  const result = await claim({
    id: "wamid-duplicate",
    from: "60123456789",
    text: "hello",
    channel: "whatsapp",
  });

  assert.equal(result, null);
  assert.deepEqual(calls.map((call) => call[0]), ["contact", "claim"]);
});

test("WhatsApp opt-out is stored and stops before lead or AI processing", async () => {
  const policyCalls = [];
  const policy = {
    isOptOutText(text) {
      return /^stop$/i.test(text.trim());
    },
    async recordOptOut(contactId, source) {
      policyCalls.push([contactId, source]);
      return { id: contactId };
    },
  };
  const { calls, claim } = makeService({ policy });

  const result = await claim({
    id: "wamid-stop",
    from: "60123456789",
    text: "STOP",
    channel: "whatsapp",
  });

  assert.equal(result, null);
  assert.deepEqual(policyCalls, [[42, "customer_message"]]);
  assert.deepEqual(calls.map((call) => call[0]), [
    "contact",
    "claim",
    "attention",
    "unread",
  ]);
  assert.equal(calls.some((call) => call[0] === "lead"), false);
  assert.equal(calls.some((call) => call[0] === "first-message"), false);
});
