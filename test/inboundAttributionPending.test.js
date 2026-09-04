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
    processing: {
      async storeInboundClaim({ contactId, content, incoming }) {
        return {
          savedInbound: { id: 500, contact_id: contactId, content },
          processingJob: {
            id: 900,
            message_id: 500,
            incoming_payload: incoming,
            status: "pending",
          },
        };
      },
      async claimPendingByMessageId(messageId) {
        assert.equal(messageId, 500);
        return { id: 900, message_id: messageId, status: "processing", attempts: 1 };
      },
      async markPrepared(messageId, wasFirstMessage) {
        assert.equal(messageId, 500);
        assert.equal(wasFirstMessage, false);
        return { id: 900, message_id: messageId, prepared_at: new Date() };
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
    events: {
      publish() {},
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
