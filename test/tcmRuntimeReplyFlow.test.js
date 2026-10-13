const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { bareServiceName, isStandaloneSpinalConcern, planTcmReviewReply } =
  require("../src/utils/tcmServiceReviewReply");
const triggers = require("../src/utils/attentionTriggers");
const { categorizeAiReview } = require("../src/utils/aiReviewPolicy");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

// Execute the actual production handler and tracked text-sending functions,
// not a reimplementation of the handler's control flow. Only external
// services are mocked; no provider or live clinic database is contacted.
function realHandlerSource() {
  const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const sendStart = source.indexOf("async function sendTrackedText(");
  const sendEnd = source.indexOf("function unwrapIncoming(", sendStart);
  const handlerStart = source.indexOf("async function processIncomingMessage(");
  const handlerEnd = source.indexOf("// Runtime secret checks", handlerStart);
  assert.ok(sendStart > 0 && sendEnd > sendStart && handlerStart > sendEnd && handlerEnd > handlerStart);
  return source.slice(sendStart, sendEnd) + "\n" +
    source.slice(handlerStart, handlerEnd) + "\nprocessIncomingMessage;";
}

function harness({ failDelivery = false } = {}) {
  const services = [{ name: "骨盆调理" }, { name: "3D 小颜术" }];
  const aliases = [
    { alias: "pelvic adjustment", officialService: "骨盆调理" },
    { alias: "face alignment", officialService: "3D 小颜术" },
  ];
  const state = {
    inbound: [], outgoing: [], accepted: [], reviews: [], errors: [],
    mode: "ai", pending: false, cancelOnReview: false, allowSend: true,
    failDelivery, deliveryFailures: 0, finalizations: [], cancellations: 0,
    fakeHistory: [], id: 0,
  };
  const contactsRepo = {
    getContactById: async () => ({ id: 7, channel: "whatsapp", whatsapp_number: "0123456789", mode: state.mode }),
    getTcmReviewEvidence: async (contactId, inboundId) => ({
      pendingClinicalReview: state.pending,
      recentCustomerTexts: state.inbound.filter(m => m.id < inboundId).slice(-8).map(m => m.text),
      // The prior accepted reply has a LATER message id than the next saved
      // inbound. We deliberately exclude it from the AI history snapshot.
      recentAcceptedAssistantTexts: state.accepted.slice(-8).map(m => m.text),
    }),
    setAiReviewAttention: async (id, inboundId, summary, category) => {
      state.pending = true;
      state.reviews.push({ inboundId, summary, category });
      if (state.cancelOnReview) state.mode = "human";
      return { id, mode: state.mode };
    },
    setDeliveryAttention: async () => { state.deliveryFailures++; },
  };
  const incomingRepo = {
    reserveOutboundAttempt: async ({ processingJobId, content }) => ({
      alreadyStarted: false,
      message: {
        id: 1000 + processingJobId, contact_id: 7, role: "assistant",
        content, created_at: new Date(),
      },
    }),
    finalizeOutboundAttempt: async (id, value) => { state.finalizations.push(value); },
    cancelOutboundAttempt: async () => { state.cancellations++; return { cancelled: true }; },
    markOutboundAttemptAmbiguous: async () => ({ message: null }),
  };
  const context = {
    console: { error: (...args) => state.errors.push(args.join(" ")), log: () => {}, warn: () => {}, info: () => {} },
    process, setTimeout, clearTimeout, Buffer,
    aiReplyCancellation: {
      keyForWhatsAppNumber: () => "whatsapp:test", snapshot: () => 0,
      safeToSend: () => state.allowSend,
      settleBeforeSend: async () => state.allowSend,
    },
    getOperationalLabels: () => ({ customerLabel: "Customer", customerSingular: "customer" }),
    clinicConfig: {
      businessType: "tcm_clinic", introMessage: "", services,
      serviceAliases: aliases, automatedFollowUp: { assessmentFirstPricingEnabled: false },
      escalation: { handoffMessage: "" },
    },
    reviewLeadTemperatureForMessage: async () => {},
    recordStaffAppointmentAcceptance: async () => null,
    pipelineRepo: { getActiveLeadForContact: async () => null },
    checkKeywordTriggers: triggers.checkKeywordTriggers,
    isUrgentSafetyMessage: triggers.isUrgentSafetyMessage,
    isActiveSafetyConcern: triggers.isActiveSafetyConcern,
    isExplicitStaffRequest: triggers.isExplicitStaffRequest,
    URGENT_SAFETY_REASON: "Urgent medical safety",
    contactsRepo,
    messagesRepo: {
      hasStaffReplyAfter: async () => false,
      socialProviderAliasRecorder: () => null,
    },
    automatedRepliesEnabled: () => true,
    conversationStore: {
      getHistoryForContact: async () => state.fakeHistory.length
        ? state.fakeHistory
        : [{ role: "user", content: state.inbound.at(-1).text }],
    },
    detectConversationLanguage: () => "en",
    whatsappPolicy: { extractQuestionAfterMarketingOptOut: () => null },
    shouldGenerateLocalizedIntro: () => false,
    loadMetaAdReplyContext: async () => null,
    resolveMetaAdCreativeService: () => null,
    ai: {
      getReply: async () => JSON.stringify({
        reply: "This needs checking.", outcome: "review_required",
        reviewType: "clinical", serviceQuery: false, priceQuery: false,
      }),
      isRecoverableAiReplyFailure: () => false,
    },
    parseAiReplyResult,
    bareServiceName, isStandaloneSpinalConcern, planTcmReviewReply,
    getAiOwnedContact: async (contact) => state.mode === "ai" ? contact : null,
    categorizeAiReview,
    inboundProcessingRepo: incomingRepo,
    channelMessaging: {
      sendText: async (contact, text, options) => {
        if (typeof options.preSendCheck === "function" && !options.preSendCheck()) {
          return { cancelled: true, success: false };
        }
        state.outgoing.push(text);
        if (state.failDelivery) {
          return { success: false, retryable: false, ambiguous: false, error: "Rejected by provider" };
        }
        state.accepted.push({ text, id: state.id + 1000 });
        return { success: true, wamid: "wamid-" + state.id };
      },
      rejectedError: () => "Rejected by provider",
    },
    realtimeEvents: { publish: () => {} },
    publishDeliveryStatus: () => {},
    persistSendOutcome: async (row) => row,
    recordReadinessSendEvidence: () => {},
    providerMessageId: (result) => result.wamid || null,
    whatsappOutboundRetry: { queueTextRetry: async () => false },
  };
  const processIncomingMessage = vm.runInNewContext(realHandlerSource(), context, {
    filename: "src/server.js",
  });
  async function receive(text, id) {
    state.id = id;
    state.inbound.push({ id, text });
    const item = {
      incoming: { id: "test-" + id, from: "0123456789", channel: "whatsapp", text },
      contact: { id: 7, channel: "whatsapp", whatsapp_number: "0123456789", mode: state.mode },
      savedInbound: { id, contact_id: 7, role: "user", content: text },
      processingJobId: id,
    };
    return processIncomingMessage(item);
  }
  return { state, receive };
}

test("real incoming-message and outbound handlers reply safely to original three-message sequence", async () => {
  const { state, receive } = harness();
  await receive("Lumber spine 4 + 5", 41);
  await receive("Pelvic adjustment", 42);
  await receive("Face alignment", 43);
  assert.deepEqual(state.errors, []);
  assert.equal(state.reviews.length, 3);
  assert.ok(state.reviews.every(r => r.category === "clinical"));
  assert.equal(state.outgoing.length, 3);
  assert.equal(state.accepted.length, 3);
  assert.equal(state.finalizations.length, 3);
  assert.ok(state.finalizations.every(r => r.outcome === "accepted"));
  assert.equal(state.pending, true);
  assert.equal(state.mode, "ai");
  assert.equal(state.outgoing.filter(r => /arrange a 1-to-1 assessment/i.test(r)).length, 1);
  assert.match(state.outgoing[1], /pelvic adjustment/i);
  assert.match(state.outgoing[2], /face alignment/i);
  assert.ok(state.outgoing.every(r => !/\bRM\s*\d|guarantee|fix your spine/i.test(r)));
});

test("staff takeover cancels the clinical acknowledgment before provider send", async () => {
  const { state, receive } = harness();
  state.cancelOnReview = true;
  await receive("Lumber spine 4 + 5", 51);
  assert.deepEqual(state.errors, []);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.outgoing.length, 0);
  assert.equal(state.mode, "human");
});

test("provider rejection preserves staff attention and never counts as accepted invite", async () => {
  const { state, receive } = harness({ failDelivery: true });
  await receive("Lumber spine 4 + 5", 61);
  assert.deepEqual(state.errors, []);
  assert.equal(state.reviews.length, 1);
  assert.equal(state.deliveryFailures, 1);
  assert.equal(state.accepted.length, 0);
  assert.equal(state.finalizations[0]?.outcome, "rejected");
  await receive("Pelvic adjustment", 62);
  assert.equal(state.accepted.length, 0);
  assert.equal(state.reviews.length, 2);
  assert.equal(state.outgoing.filter(r => /arrange a 1-to-1 assessment/i.test(r)).length, 2,
    "failed invitations should not suppress a later attempt");
});
