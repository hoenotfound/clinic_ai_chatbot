const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageClaimService,
} = require("../src/services/inboundMessageClaimService");

test("old open social journey consumes pending referral without re-attributing the lead", async () => {
  const calls = [];
  const claim = createInboundMessageClaimService({
    contacts: {
      async getOrCreateContact() { throw new Error("unexpected WhatsApp path"); },
      async getOrCreateChannelContact() {
        return { id: 12, channel: "instagram", mode: "ai" };
      },
      async setUnread() {},
    },
    store: {
      async appendInboundMessageIfNew() {
        return { id: 500, contact_id: 12 };
      },
    },
    pipeline: {
      async ensureLeadForContact() {
        return {
          created: false,
          lead: { id: 88, started_message_id: 400 },
        };
      },
    },
    attribution: {
      async captureForInbound() {
        calls.push("capture");
      },
      async consumePendingForInbound(incoming) {
        calls.push(["consume", incoming.channel, incoming.from]);
      },
    },
    messages: {
      async getMessagePageForContact() {
        return { rows: [{ id: 500 }, { id: 400 }], hasMore: true };
      },
    },
  });

  await claim({
    id: "m_ig_old",
    channel: "instagram",
    from: "igsid-88",
    text: "hello again",
  });

  assert.deepEqual(calls, [["consume", "instagram", "igsid-88"]]);
});
