const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageClaimService,
} = require("../src/services/inboundMessageClaimService");

function makeClaim({ leadOutcome }) {
  const calls = [];
  const contacts = {
    async getOrCreateContact() {
      return { id: 7, channel: "whatsapp", mode: "ai" };
    },
    async getOrCreateChannelContact() {
      throw new Error("unexpected social path");
    },
    async setUnread() {},
  };
  const store = {
    async appendInboundMessageIfNew() {
      return { id: 101, contact_id: 7, content: "hello" };
    },
  };
  const pipeline = {
    async ensureLeadForContact() {
      return leadOutcome;
    },
  };
  const attribution = {
    async rememberPendingReferral() {},
    async captureForInbound(payload) {
      calls.push(payload);
    },
  };
  const messages = {
    async getMessagePageForContact() {
      return { rows: [{ id: 101 }], hasMore: false };
    },
  };

  return {
    calls,
    claim: createInboundMessageClaimService({
      contacts,
      store,
      pipeline,
      attribution,
      messages,
    }),
  };
}

test("captures first-touch attribution when this inbound creates the lead journey", async () => {
  const { calls, claim } = makeClaim({
    leadOutcome: {
      created: true,
      lead: { id: 55, started_message_id: 101 },
    },
  });

  await claim({
    id: "wamid-new",
    from: "60120000000",
    channel: "whatsapp",
    text: "hello",
    attribution: { source: "meta_ads", adId: "ad-1" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].lead.id, 55);
  assert.equal(calls[0].firstMessageId, 101);
});

test("does not retrofit an old open journey with a later ad click", async () => {
  const { calls, claim } = makeClaim({
    leadOutcome: {
      created: false,
      lead: { id: 56, started_message_id: 80 },
    },
  });

  await claim({
    id: "wamid-old-lead-new-ad",
    from: "60120000000",
    channel: "whatsapp",
    text: "hello again",
    attribution: { source: "meta_ads", adId: "new-ad" },
  });

  assert.equal(calls.length, 0);
});

test("concurrent lead creation can still attribute when the journey boundary is this message", async () => {
  const { calls, claim } = makeClaim({
    leadOutcome: {
      created: false,
      lead: { id: 57, started_message_id: 101 },
    },
  });

  await claim({
    id: "wamid-concurrent",
    from: "60120000000",
    channel: "whatsapp",
    text: "hello",
    attribution: { source: "meta_ads", adId: "ad-concurrent" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].lead.id, 57);
});

test("attribution-only social referral does not create a contact or message", async () => {
  let contactTouched = false;
  let pendingSaved = false;
  const claim = createInboundMessageClaimService({
    contacts: {
      async getOrCreateContact() { contactTouched = true; },
      async getOrCreateChannelContact() { contactTouched = true; },
    },
    messages: {},
    pipeline: {},
    store: {},
    attribution: {
      async rememberPendingReferral() { pendingSaved = true; },
    },
  });

  const result = await claim({
    attributionOnly: true,
    id: "referral-1",
    channel: "instagram",
    from: "igsid-1",
    attribution: { source: "meta_ads", adId: "ad-ig" },
  });

  assert.equal(result, null);
  assert.equal(pendingSaved, true);
  assert.equal(contactTouched, false);
});
