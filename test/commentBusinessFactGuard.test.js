"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { correctVerifiedCommentBusinessReply, verifiedAnswerKind } =
  require("../src/utils/commentBusinessFactGuard");

const config = {
  branches: [{
    name: "Petaling Jaya (PJ)",
    address: "Section 19/1, Petaling Jaya, Selangor",
  }],
  hours: { general: "Tue-Fri 10am-8pm; Sat-Sun 10am-6pm", closed: "Monday closed" },
};
const awaitingStaff = {
  shouldRespond: true,
  flagged: true,
  privateReply: "我帮您向团队确认一下具体的分店位置后再回复您可以吗？",
  publicReply: "Please DM us",
};

test("clear Chinese Penang comment gets the verified PJ branch and no staff review", () => {
  const result = correctVerifiedCommentBusinessReply({
    customerText: "有在槟城有店铺吗?",
    copy: awaitingStaff,
    config,
  });
  assert.equal(result.flagged, false);
  assert.match(result.privateReply, /Petaling Jaya/);
  assert.match(result.privateReply, /Section 19\/1/);
  assert.doesNotMatch(result.privateReply, /团队|确认一下/);
});

test("English and Malay simple branch queries use the same configured address", () => {
  for (const text of ["Is there a branch in Penang?", "Ada cawangan di Penang?"]) {
    const result = correctVerifiedCommentBusinessReply({
      customerText: text,
      copy: { ...awaitingStaff, privateReply: "I'll check with the team and get back to you." },
      config,
    });
    assert.equal(result.flagged, false, text);
    assert.match(result.privateReply, /Petaling Jaya/, text);
    assert.match(result.privateReply, /Section 19\/1/, text);
  }
});

test("known opening hours can resolve an unnecessary administrative handoff", () => {
  const result = correctVerifiedCommentBusinessReply({
    customerText: "What are your opening hours?",
    copy: { ...awaitingStaff, privateReply: "I'll confirm with the team." },
    config,
  });
  assert.equal(result.flagged, false);
  assert.match(result.privateReply, /Tue-Fri 10am-8pm/);
});

test("natural verified AI replies remain untouched", () => {
  const normal = { ...awaitingStaff, flagged: false, privateReply: "We're in PJ 😊" };
  assert.equal(correctVerifiedCommentBusinessReply({
    customerText: "Where is your clinic?", copy: normal, config,
  }), normal);
});

test("medical, complaint, human requests and mixed price questions keep review", () => {
  for (const text of [
    "Is the clinic safe after surgery?",
    "My breasts hurt, where is your clinic?",
    "Where is your clinic? I want a refund",
    "Can I speak to staff at the clinic?",
    "Where is your clinic and how much is pelvic treatment?",
    "Is there a branch in Penang? I have breast cancer",
  ]) {
    const result = correctVerifiedCommentBusinessReply({
      customerText: text, copy: awaitingStaff, config,
    });
    assert.equal(result, awaitingStaff, text);
  }
});

test("unknown or ambiguous branch facts never suppress staff review", () => {
  for (const branches of [
    [],
    [{ name: "PJ", address: "" }],
    [config.branches[0], { name: "Penang", address: "Penang" }],
  ]) {
    const result = correctVerifiedCommentBusinessReply({
      customerText: "有在槟城有店铺吗?",
      copy: awaitingStaff,
      config: { ...config, branches },
    });
    assert.equal(result, awaitingStaff);
  }
});

test("deterministic safety handoff and skipped comments are preserved", () => {
  for (const copy of [
    { ...awaitingStaff, deterministicSafety: true },
    { ...awaitingStaff, shouldRespond: false },
  ]) {
    assert.equal(correctVerifiedCommentBusinessReply({
      customerText: "Where is your clinic?", copy, config,
    }), copy);
  }
});

test("location recognition stays narrow", () => {
  assert.equal(verifiedAnswerKind("有在槟城有店铺吗?"), "location");
  assert.equal(verifiedAnswerKind("Where is your clinic?"), "location");
  assert.equal(verifiedAnswerKind("Ada cawangan di Penang?"), "location");
  assert.equal(verifiedAnswerKind("营业时间是几点？"), "hours");
  assert.equal(verifiedAnswerKind("Pelvic treatment price?"), null);
});


test("comment processing sends the corrected DM without creating false staff attention", async () => {
  const { createMetaCommentAutomationService, DEFAULT_COMMENT_AUTOMATION } =
    require("../src/services/metaCommentAutomationService");
  const original = {
    id: 321, channel: "facebook", commentId: "comment-321",
    entryId: "page-1", authorId: "author-321", authorName: "Sandy",
    text: "有在槟城有店铺吗?", postId: "post-1", mediaId: null,
    parentCommentId: null, rawEvent: {}, attemptCount: 1,
    publicReplyId: null, privateReplyMessageId: null,
  };
  let job = { ...original };
  let sentText = null;
  let savedText = null;
  let attentionCalls = 0;
  const repo = {
    claimJob: async () => job,
    markSkipped: async () => assert.fail("must not skip a valid business question"),
    markFailed: async (_id, err) => { throw err; },
    markPrivateReplyPending: async (_id, { text }) => {
      job = { ...job, privateReplyPendingText: text };
      return job;
    },
    markPrivateReplySent: async (_id, data) => {
      job = { ...job, privateReplyMessageId: data.messageId,
        privateReplyRecipientId: data.recipientId };
      return job;
    },
    markCompleted: async () => ({ ...job, status: "completed" }),
  };
  const meta = {
    sendPrivateReplyToComment: async (_channel, _commentId, text) => {
      sentText = text;
      return { success: true, messageId: "mid-321", recipientId: "psid-321" };
    },
    replyToComment: async () => assert.fail("public replies remain disabled"),
  };
  const aiClient = {
    getReply: async () => JSON.stringify({
      reply: awaitingStaff.privateReply,
      outcome: "needs_human",
      publicReply: "",
      privateReply: awaitingStaff.privateReply,
      shouldRespond: true,
    }),
  };
  const contacts = {
    getOrCreateChannelContact: async () => ({ id: 321 }),
    setAttention: async () => { attentionCalls += 1; },
  };
  const service = createMetaCommentAutomationService({
    repo, meta, aiClient, contacts,
    messages: { getMessageByProviderIdForContact: async () => null },
    store: {
      appendMessageForContact: async (_id, _role, text) => {
        savedText = text;
        return { id: 4321 };
      },
    },
    pipeline: { ensureLeadForContact: async () => ({ lead: null }) },
    config: {
      ...config,
      commentAutomation: {
        ...DEFAULT_COMMENT_AUTOMATION,
        enabled: true, publicReplyEnabled: false, privateReplyEnabled: true,
      },
    },
    repliesEnabled: () => true,
  });
  const result = await service.processJob(original.id);
  assert.equal(result.status, "completed");
  assert.match(sentText, /Petaling Jaya/);
  assert.equal(savedText, sentText);
  assert.equal(attentionCalls, 0);
});

test("social comment prompt reads locations, hours and FAQs from the live shared config", () => {
  const liveConfig = require("../src/config/clinicConfig");
  const { buildSystemPrompt } = require("../src/utils/systemPrompt");
  const original = {
    branches: liveConfig.branches, hours: liveConfig.hours, faqs: liveConfig.faqs,
  };
  try {
    liveConfig.branches = config.branches;
    liveConfig.hours = config.hours;
    liveConfig.faqs = [{ q: "Do you accept walk-ins?", a: "Appointment preferred" }];
    const prompt = buildSystemPrompt({
      surface: "comment_automation", channel: "facebook",
      commentText: "有在槟城有店铺吗?",
      publicReplyEnabled: false, privateReplyEnabled: true,
    });
    assert.match(prompt, /Petaling Jaya/);
    assert.match(prompt, /Section 19\/1/);
    assert.match(prompt, /Tue-Fri 10am-8pm/);
    assert.match(prompt, /Do you accept walk-ins/);
    assert.match(prompt, /Do not defer a fact that is already configured/i);
    assert.match(prompt, /applies ONLY to that exact configured service/i);
  } finally {
    liveConfig.branches = original.branches;
    liveConfig.hours = original.hours;
    liveConfig.faqs = original.faqs;
  }
});
