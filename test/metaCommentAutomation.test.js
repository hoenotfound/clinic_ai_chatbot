const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCommentAttribution,
  createMetaCommentAutomationService,
  parseIncomingCommentEvents,
  skipReason,
  DEFAULT_COMMENT_AUTOMATION,
} = require("../src/services/metaCommentAutomationService");

test("parses Facebook Page feed comment additions and detects nested replies", () => {
  const events = parseIncomingCommentEvents({
    object: "page",
    entry: [{
      id: "page-1",
      changes: [
        {
          field: "feed",
          value: {
            item: "comment",
            verb: "add",
            comment_id: "comment-1",
            post_id: "page-1_post-1",
            parent_id: "page-1_post-1",
            message: "How much is this?",
            from: { id: "user-1", name: "Jane" },
            created_time: 1790395200,
          },
        },
        {
          field: "feed",
          value: {
            item: "comment",
            verb: "add",
            comment_id: "comment-2",
            post_id: "page-1_post-1",
            parent_id: "comment-1",
            message: "Nested",
            from: { id: "user-2", name: "John" },
          },
        },
      ],
    }],
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].channel, "facebook");
  assert.equal(events[0].commentId, "comment-1");
  assert.equal(events[0].parentCommentId, null);
  assert.equal(events[1].parentCommentId, "comment-1");
});

test("parses Instagram comments webhook payloads", () => {
  const [event] = parseIncomingCommentEvents({
    object: "instagram",
    entry: [{
      id: "ig-business-1",
      changes: [{
        field: "comments",
        value: {
          id: "ig-comment-1",
          text: "Price pls",
          from: { id: "igsid-1", username: "alicia" },
          media: { id: "ig-media-1" },
        },
      }],
    }],
  });

  assert.deepEqual(
    {
      channel: event.channel,
      commentId: event.commentId,
      entryId: event.entryId,
      authorId: event.authorId,
      authorName: event.authorName,
      mediaId: event.mediaId,
    },
    {
      channel: "instagram",
      commentId: "ig-comment-1",
      entryId: "ig-business-1",
      authorId: "igsid-1",
      authorName: "alicia",
      mediaId: "ig-media-1",
    }
  );
});

test("comment attribution keeps channel-specific comment source and exact Meta ad ids when available", () => {
  const organic = buildCommentAttribution(
    {
      channel: "instagram",
      commentId: "ig-comment-organic",
      mediaId: "ig-media-organic",
      postId: null,
      text: "Price?",
      rawEvent: { value: {} },
    },
    {
      text: "Radiance Therapy",
      mediaType: "IMAGE",
      sourceUrl: "https://instagram.example/p/radiance",
    }
  );
  assert.equal(organic.source, "instagram_comment");
  assert.equal(organic.sourceId, "ig-media-organic");
  assert.equal(organic.referralType, "comment");
  assert.equal(organic.headline, "Radiance Therapy");
  assert.match(organic.body, /Price\?/);

  const paid = buildCommentAttribution(
    {
      channel: "facebook",
      commentId: "fb-comment-ad",
      postId: "page-1_post-9",
      mediaId: null,
      text: "Can I know more?",
      rawEvent: {
        value: {
          ad_id: "123456789",
          ad_title: "Pelvic care campaign",
        },
      },
    },
    {
      text: "Post copy",
      sourceUrl: "https://facebook.example/posts/9",
    }
  );
  assert.equal(paid.source, "meta_ads");
  assert.equal(paid.adId, "123456789");
  assert.equal(paid.referralType, "comment");
  assert.equal(paid.headline, "Pelvic care campaign");
});

test("skip rules ignore self comments, emoji-only comments, and nested replies", () => {
  const settings = { ...DEFAULT_COMMENT_AUTOMATION, enabled: true };
  assert.match(
    skipReason(
      { channel: "instagram", entryId: "biz", authorId: "biz", commentId: "1", text: "hello" },
      settings
    ),
    /business account/
  );
  assert.match(
    skipReason(
      { channel: "instagram", entryId: "biz", authorId: "u1", commentId: "2", text: "🔥🔥" },
      settings
    ),
    /emoji/
  );
  assert.match(
    skipReason(
      {
        channel: "instagram",
        entryId: "biz",
        authorId: "u1",
        commentId: "3",
        text: "reply",
        parentCommentId: "parent",
      },
      settings
    ),
    /nested/
  );
});

test("processes one comment with public + private reply and creates a lead only after private reply succeeds", async () => {
  const calls = [];
  const stored = {
    id: 7,
    channel: "instagram",
    commentId: "c-7",
    entryId: "ig-business",
    authorId: "author",
    authorName: "Alicia",
    text: "How much?",
    postId: null,
    mediaId: "m-7",
    parentCommentId: null,
    sourceCreatedAt: new Date().toISOString(),
    rawEvent: {},
    attemptCount: 1,
    publicReplyId: null,
    privateReplyMessageId: null,
  };

  const repo = {
    storeIncomingComment: async () => stored,
    claimJob: async () => stored,
    markPublicReplySent: async (id, replyId) => ({ ...stored, publicReplyId: replyId }),
    markPrivateReplySent: async (id, data) => ({
      ...stored,
      publicReplyId: "pub-1",
      privateReplyMessageId: data.messageId,
      privateReplyRecipientId: data.recipientId,
    }),
    markCompleted: async () => ({ ...stored, status: "completed" }),
    markFailed: async () => assert.fail("should not fail"),
    markSkipped: async () => assert.fail("should not skip"),
    listRecoverable: async () => [],
  };
  const meta = {
    fetchCommentSourceContext: async (channel, source) => {
      calls.push(["context", channel, source.mediaId]);
      return {
        sourceId: source.mediaId,
        text: "Skin consultation promotion RM588",
        mediaType: "IMAGE",
        sourceUrl: "https://instagram.example/p/skin",
      };
    },
    replyToComment: async (channel, id, text) => {
      calls.push(["public", channel, id, text]);
      return { success: true, replyId: "pub-1" };
    },
    sendPrivateReplyToComment: async (channel, id, text) => {
      calls.push(["private", channel, id, text]);
      return {
        success: true,
        messageId: "dm-1",
        recipientId: "igsid-77",
      };
    },
  };
  const aiClient = {
    getReply: async (messages) => {
      calls.push(["ai", messages[0].content]);
      return JSON.stringify({
      reply: "Hi! Which area are you asking about?",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
      projectLocation: null,
      projectSummary: null,
      nextStep: null,
      publicReply: "Hi! I've sent you a DM 😊",
      privateReply: "Hi! Which area are you asking about?",
      shouldRespond: true,
      });
    },
  };
  const contacts = {
    getOrCreateChannelContact: async (...args) => {
      calls.push(["contact", ...args]);
      return { id: 99 };
    },
    setAttention: async () => {},
  };
  const messages = {
    getMessageByProviderIdForContact: async (...args) => {
      calls.push(["lookup", ...args]);
      return null;
    },
  };
  const store = {
    appendMessageForContact: async (...args) => {
      calls.push(["message", ...args]);
      return { id: 123 };
    },
  };
  const pipeline = {
    ensureLeadForContact: async (...args) => {
      calls.push(["lead", ...args]);
      return {
        created: true,
        lead: { id: 707, started_message_id: args[2] },
      };
    },
  };
  const attribution = {
    captureForInbound: async (payload) => {
      calls.push(["attribution", payload]);
      return { id: 1 };
    },
  };
  const config = {
    businessType: "aesthetic_clinic",
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      enabled: true,
      activatedAt: new Date(Date.now() - 1000).toISOString(),
    },
  };

  const service = createMetaCommentAutomationService({
    repo,
    meta,
    aiClient,
    contacts,
    messages,
    pipeline,
    store,
    attribution,
    config,
    repliesEnabled: () => true,
  });

  await service.processJob(stored.id);

  assert.deepEqual(calls[0], ["context", "instagram", "m-7"]);
  assert.equal(calls[1][0], "ai");
  assert.match(calls[1][1], /Post\/ad context: Skin consultation promotion RM588/);
  assert.equal(calls[2][0], "public");
  assert.equal(calls[3][0], "private");
  assert.deepEqual(calls[4].slice(0, 4), ["contact", "instagram", "igsid-77", "Alicia"]);
  assert.deepEqual(calls[5], ["lookup", 99, "dm-1"]);
  assert.equal(calls[6][0], "message");
  assert.deepEqual(calls[7].slice(0, 3), ["lead", 99, "Comment Automation"]);
  assert.equal(calls[8][0], "attribution");
  assert.equal(calls[8][1].lead.id, 707);
  assert.equal(calls[8][1].incoming.attribution.source, "instagram_comment");
  assert.equal(calls[8][1].incoming.attribution.sourceId, "m-7");
  assert.match(calls[8][1].incoming.attribution.headline, /Skin consultation promotion/);
});

test("comment scheduler serializes jobs so bursts do not consume AI capacity concurrently", async () => {
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const jobs = new Map([
    [1, {
      id: 1, channel: "facebook", commentId: "c1", entryId: "page",
      authorId: "u1", authorName: "One", text: "one", postId: "post1",
      mediaId: null, parentCommentId: null, sourceCreatedAt: new Date().toISOString(),
      rawEvent: {}, attemptCount: 1, publicReplyId: null, privateReplyMessageId: null,
    }],
    [2, {
      id: 2, channel: "facebook", commentId: "c2", entryId: "page",
      authorId: "u2", authorName: "Two", text: "two", postId: "post2",
      mediaId: null, parentCommentId: null, sourceCreatedAt: new Date().toISOString(),
      rawEvent: {}, attemptCount: 1, publicReplyId: null, privateReplyMessageId: null,
    }],
  ]);
  const repo = {
    claimJob: async (id) => jobs.get(id),
    markPublicReplySent: async (id, replyId) => ({ ...jobs.get(id), publicReplyId: replyId }),
    markCompleted: async (id) => ({ ...jobs.get(id), status: "completed" }),
    markFailed: async () => assert.fail("should not fail"),
    markSkipped: async () => assert.fail("should not skip"),
    listRecoverable: async () => [],
  };
  const meta = {
    fetchCommentSourceContext: async () => null,
    replyToComment: async (channel, commentId) => {
      order.push(`start:${commentId}`);
      if (commentId === "c1") await firstGate;
      order.push(`end:${commentId}`);
      return { success: true, replyId: `reply:${commentId}` };
    },
  };
  const aiClient = {
    getReply: async () => JSON.stringify({
      reply: "Thanks",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
      projectLocation: null,
      projectSummary: null,
      nextStep: null,
      publicReply: "Thanks",
      privateReply: "",
      shouldRespond: true,
    }),
  };
  const config = {
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      enabled: true,
      privateReplyEnabled: false,
      activatedAt: new Date(Date.now() - 1000).toISOString(),
    },
  };
  const service = createMetaCommentAutomationService({
    repo,
    meta,
    aiClient,
    config,
    repliesEnabled: () => true,
  });

  const first = service.scheduleJob(1);
  const second = service.scheduleJob(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:c1"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["start:c1", "end:c1", "start:c2", "end:c2"]);
});

test("repairs Inbox and Pipeline state after a private reply was already checkpointed without resending it", async () => {
  const calls = [];
  const stored = {
    id: 8,
    channel: "facebook",
    commentId: "c-8",
    entryId: "page-8",
    authorId: "psid-8",
    authorName: "Ben",
    text: "Can I know more?",
    postId: "page-8_post-8",
    mediaId: null,
    parentCommentId: null,
    sourceCreatedAt: new Date().toISOString(),
    rawEvent: {},
    attemptCount: 2,
    publicReplyId: "pub-8",
    privateReplyMessageId: "dm-8",
    privateReplyRecipientId: "psid-8",
  };

  const repo = {
    claimJob: async () => stored,
    markCompleted: async () => ({ ...stored, status: "completed" }),
    markFailed: async () => assert.fail("should not fail"),
    markSkipped: async () => assert.fail("should not skip"),
    listRecoverable: async () => [],
  };
  const meta = {
    replyToComment: async () => assert.fail("must not resend public reply"),
    sendPrivateReplyToComment: async () => assert.fail("must not resend private reply"),
  };
  const aiClient = {
    getReply: async () => JSON.stringify({
      reply: "Sure 😊 What would you like to know?",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
      projectLocation: null,
      projectSummary: null,
      nextStep: null,
      publicReply: "Happy to help 😊",
      privateReply: "Sure 😊 What would you like to know?",
      shouldRespond: true,
    }),
  };
  const contacts = {
    getOrCreateChannelContact: async (...args) => {
      calls.push(["contact", ...args]);
      return { id: 108 };
    },
    setAttention: async () => {},
  };
  const existing = { id: 808, contact_id: 108, whatsapp_message_id: "dm-8" };
  const messages = {
    getMessageByProviderIdForContact: async (...args) => {
      calls.push(["lookup", ...args]);
      return existing;
    },
  };
  const store = {
    appendMessageForContact: async () => assert.fail("must not duplicate Inbox message"),
  };
  const pipeline = {
    ensureLeadForContact: async (...args) => {
      calls.push(["lead", ...args]);
      return { created: false };
    },
  };
  const config = {
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      enabled: true,
      activatedAt: new Date(Date.now() - 1000).toISOString(),
    },
  };

  const service = createMetaCommentAutomationService({
    repo,
    meta,
    aiClient,
    contacts,
    messages,
    pipeline,
    store,
    config,
    repliesEnabled: () => true,
  });

  await service.processJob(stored.id);

  assert.deepEqual(calls[0].slice(0, 4), ["contact", "facebook", "psid-8", "Ben"]);
  assert.deepEqual(calls[1], ["lookup", 108, "dm-8"]);
  assert.deepEqual(calls[2].slice(0, 4), ["lead", 108, "Comment Automation", 808]);
});
