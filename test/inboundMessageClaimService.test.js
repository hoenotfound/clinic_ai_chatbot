const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInboundMessageClaimService,
} = require("../src/services/inboundMessageClaimService");

function makeService({
  duplicate = false,
  policy = undefined,
  reengagement = undefined,
} = {}) {
  const calls = [];
  let completed = false;
  const contacts = {
    async getOrCreateContact(from, profileName) {
      calls.push(["contact", from, profileName]);
      return { id: 42, mode: "ai", channel: "whatsapp" };
    },
    async getOrCreateChannelContact() {
      throw new Error("unexpected social contact path");
    },
    async getContactById(id) {
      calls.push(["contact-by-id", id]);
      return { id, mode: "ai", channel: "whatsapp" };
    },
    async setUnread(id, unread) {
      calls.push(["unread", id, unread]);
    },
    async setAttention(id, needsAttention, reason) {
      calls.push(["attention", id, needsAttention, reason]);
    },
  };
  const processing = {
    async storeInboundClaim({ contactId, content, storedMessageId, incoming }) {
      calls.push(["claim", contactId, content, storedMessageId, incoming.id]);
      if (duplicate) return null;
      return {
        savedInbound: { id: 777, contact_id: contactId, content },
        processingJob: {
          id: 91,
          message_id: 777,
          incoming_payload: incoming,
          status: "pending",
        },
        derivedFirstMessage: true,
      };
    },
    async claimPendingByMessageId(messageId) {
      calls.push(["processing-claim", messageId]);
      return { id: 91, message_id: messageId, status: "processing", attempts: 1 };
    },
    async markPrepared(messageId, wasFirstMessage) {
      calls.push(["prepared", messageId, wasFirstMessage]);
      return { id: 91, message_id: messageId, prepared_at: new Date() };
    },
    async markCompletedByMessageId(messageId) {
      calls.push(["completed", messageId]);
      completed = true;
      return { id: 91, message_id: messageId, status: "completed" };
    },
    async markFailed(jobId, err) {
      calls.push(["failed", jobId, err?.message]);
      return { id: jobId, status: "failed" };
    },
    async getJobContext(jobId) {
      calls.push(["job-context", jobId]);
      return {
        job: {
          id: jobId,
          contact_id: 42,
          incoming_payload: {
            id: "wamid-recovered",
            from: "60123456789",
            text: "hello",
            channel: "whatsapp",
          },
          status: "processing",
          prepared_at: null,
          was_first_message: null,
        },
        savedInbound: { id: 777, contact_id: 42, content: "hello" },
        derivedFirstMessage: true,
      };
    },
  };
  const pipeline = {
    async ensureLeadForContact(contactId, actor, messageId) {
      calls.push(["lead", contactId, actor, messageId]);
      return {
        created: true,
        lead: { id: 9, started_message_id: messageId },
      };
    },
  };
  const messages = {
    async getMessagePageForContact(contactId) {
      calls.push(["first-message", contactId]);
      return { rows: [{ id: 777 }], hasMore: false };
    },
  };
  const attribution = {
    async captureForInbound() {
      calls.push(["attribution"]);
    },
    async consumePendingForInbound() {
      calls.push(["consume-attribution"]);
    },
    async rememberPendingReferral() {},
  };
  const events = {
    publish(event, payload) {
      calls.push(["event", event, payload.messageId]);
    },
  };
  const reengagementService = reengagement || {
    async notifyIfReengaged() {
      return { status: "skipped", reason: "test-default" };
    },
  };

  const claim = createInboundMessageClaimService({
    contacts,
    processing,
    pipeline,
    messages,
    attribution,
    events,
    reengagement: reengagementService,
    ...(policy ? { policy } : {}),
  });

  return {
    calls,
    claim,
    wasCompleted: () => completed,
  };
}

test("durability phase stores message + job without running reply preparation", async () => {
  const { calls, claim } = makeService();
  const durable = await claim.storeIncomingMessage({
    id: "wamid-pre-ack",
    from: "60123456789",
    profileName: "Patient",
    text: "how much hifu",
    channel: "whatsapp",
  });

  assert.equal(durable.savedInbound.id, 777);
  assert.equal(durable.processingJob.status, "pending");
  assert.equal(durable.derivedFirstMessage, true);
  assert.equal(durable.hasDerivedFirstMessage, true);
  assert.deepEqual(calls.map((call) => call[0]), ["contact", "claim", "event"]);
  assert.equal(calls.some((call) => call[0] === "lead"), false);
  assert.equal(calls.some((call) => call[0] === "processing-claim"), false);
});

test("live preparation leases the durable job and preserves the persistence-time first-message boundary", async () => {
  const { calls, claim } = makeService();
  const durable = await claim.storeIncomingMessage({
    id: "wamid-1",
    from: "60123456789",
    profileName: "Patient",
    text: "how much hifu",
    channel: "whatsapp",
  });
  const result = await claim.prepareIncomingClaim(durable);

  assert.equal(result.savedInbound.id, 777);
  assert.equal(result.processingJobId, 91);
  assert.equal(result.wasFirstMessage, true);
  assert.deepEqual(calls.map((call) => call[0]), [
    "contact",
    "claim",
    "event",
    "processing-claim",
    "unread",
    "lead",
    "attribution",
    "prepared",
  ]);
  assert.equal(calls.some((call) => call[0] === "first-message"), false);
});

test("live preparation evaluates lead re-engagement after the lead is resolved", async () => {
  const reengagementCalls = [];
  const { claim } = makeService({
    reengagement: {
      async notifyIfReengaged(input) {
        reengagementCalls.push(input);
        return { status: "queued", alertId: 501 };
      },
    },
  });

  const durable = await claim.storeIncomingMessage({
    id: "wamid-returning",
    from: "60123456789",
    profileName: "Patient",
    text: "Hi, is the promo still available?",
    channel: "whatsapp",
  });
  await claim.prepareIncomingClaim(durable);

  assert.deepEqual(reengagementCalls, [{
    contactId: 42,
    currentMessageId: 777,
    leadId: 9,
  }]);
});

test("lead re-engagement alert failures never fail inbound preparation", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  const { claim } = makeService({
    reengagement: {
      async notifyIfReengaged() {
        throw new Error("Telegram re-engagement lookup failed");
      },
    },
  });

  const durable = await claim.storeIncomingMessage({
    id: "wamid-returning-error",
    from: "60123456789",
    profileName: "Patient",
    text: "Hello again",
    channel: "whatsapp",
  });
  const prepared = await claim.prepareIncomingClaim(durable);

  assert.equal(prepared.savedInbound.id, 777);
  assert.equal(prepared.processingJobId, 91);
});

test("duplicate webhook claims stop before later side effects", async () => {
  const { calls, claim } = makeService({ duplicate: true });
  const result = await claim.storeIncomingMessage({
    id: "wamid-duplicate",
    from: "60123456789",
    text: "hello",
    channel: "whatsapp",
  });

  assert.equal(result, null);
  assert.deepEqual(calls.map((call) => call[0]), ["contact", "claim"]);
});

test("WhatsApp opt-out completes its durable job without AI preparation", async () => {
  const policyCalls = [];
  const policy = {
    isOptOutText(text) {
      return /^stop$/i.test(String(text || "").trim());
    },
    async recordOptOut(contactId, source) {
      policyCalls.push([contactId, source]);
      return { id: contactId };
    },
  };
  const { calls, claim, wasCompleted } = makeService({ policy });

  const durable = await claim.storeIncomingMessage({
    id: "wamid-stop",
    from: "60123456789",
    text: "STOP",
    channel: "whatsapp",
  });
  const result = await claim.prepareIncomingClaim(durable);

  assert.equal(result, null);
  assert.equal(wasCompleted(), true);
  assert.deepEqual(policyCalls, [[42, "customer_message"]]);
  assert.deepEqual(calls.map((call) => call[0]), [
    "contact",
    "claim",
    "event",
    "attention",
    "unread",
    "completed",
  ]);
  assert.equal(calls.some((call) => call[0] === "processing-claim"), false);
  assert.equal(calls.some((call) => call[0] === "lead"), false);
  assert.equal(calls.some((call) => call[0] === "prepared"), false);
});

test("an unprepared recovered job keeps durable first-message state", async () => {
  const { calls, claim } = makeService();
  const result = await claim.resumeProcessingJob({ id: 91 });

  assert.equal(result.savedInbound.id, 777);
  assert.equal(result.wasFirstMessage, true);
  assert.equal(result.processingJobId, 91);
  assert.deepEqual(calls.map((call) => call[0]), [
    "job-context",
    "contact-by-id",
    "unread",
    "lead",
    "attribution",
    "prepared",
  ]);
  assert.equal(calls.some((call) => call[0] === "first-message"), false);
  const preparedCall = calls.find((call) => call[0] === "prepared");
  assert.equal(preparedCall[2], true);
});

test("WhatsApp marketing opt-out completes the durable job without creating a global opt-out", async () => {
  const calls = [];
  const policy = {
    classifyOptOutText(text) {
      return /^stop promotions$/i.test(String(text || "").trim()) ? "marketing" : null;
    },
    isOptOutText() {
      return false;
    },
    async recordMarketingOptOut(contactId, source) {
      calls.push(["marketing-opt-out", contactId, source]);
      return { id: contactId };
    },
    async recordOptOut() {
      assert.fail("marketing-only opt-out must not record a global opt-out");
    },
  };
  const { claim, wasCompleted } = makeService({ policy });

  const durable = await claim.storeIncomingMessage({
    id: "wamid-stop-promotions",
    from: "60123456789",
    text: "Stop promotions",
    buttonPayload: "Stop promotions",
    channel: "whatsapp",
  });
  const result = await claim.prepareIncomingClaim(durable);

  assert.equal(result, null);
  assert.equal(wasCompleted(), true);
  assert.deepEqual(calls, [["marketing-opt-out", 42, "customer_quick_reply"]]);
});

