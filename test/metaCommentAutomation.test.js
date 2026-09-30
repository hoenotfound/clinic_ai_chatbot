const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCommentAttribution,
  createMetaCommentAutomationService,
  deterministicCommentSafetyCopy,
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

test("does not persist comment jobs while the feature or global automated replies are paused", async () => {
  let stores = 0;
  const repo = {
    storeIncomingComment: async () => {
      stores += 1;
      return { id: stores };
    },
  };
  const body = {
    object: "facebook",
    entry: [{
      id: "page-1",
      changes: [{
        field: "feed",
        value: {
          item: "comment",
          verb: "add",
          comment_id: "comment-kill-switch",
          post_id: "page-1_post-1",
          parent_id: "page-1_post-1",
          message: "Price?",
          from: { id: "user-1", name: "Jane" },
        },
      }],
    }],
  };

  const disabled = createMetaCommentAutomationService({
    repo,
    config: {
      commentAutomation: {
        ...DEFAULT_COMMENT_AUTOMATION,
        enabled: false,
      },
    },
    repliesEnabled: () => true,
  });
  assert.deepEqual(await disabled.acceptIncomingComments(body), []);
  assert.equal(stores, 0);

  const globallyPaused = createMetaCommentAutomationService({
    repo,
    config: {
      commentAutomation: {
        ...DEFAULT_COMMENT_AUTOMATION,
        enabled: true,
      },
    },
    repliesEnabled: () => false,
  });
  assert.deepEqual(await globallyPaused.acceptIncomingComments(body), []);
  assert.equal(stores, 0);
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

  let privateReplyReserved = false;
  const repo = {
    storeIncomingComment: async () => stored,
    claimJob: async () => stored,
    markPublicReplySent: async (id, replyId) => ({ ...stored, publicReplyId: replyId }),
    markPrivateReplyPending: async (id, data) => {
      assert.equal(id, stored.id);
      assert.equal(data.text, "Hi! Which area are you asking about?");
      privateReplyReserved = true;
      return {
        ...stored,
        publicReplyId: "pub-1",
        privateReplyPendingText: data.text,
      };
    },
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
      assert.equal(privateReplyReserved, true);
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
  assert.deepEqual(calls[5], ["lookup", 99, "instagram:dm-1"]);
  assert.deepEqual(calls[6], ["lookup", 99, "dm-1"]);
  assert.equal(calls[7][0], "message");
  assert.equal(calls[7][4], "instagram:dm-1");
  assert.deepEqual(calls[8].slice(0, 3), ["lead", 99, "Comment Automation"]);
  assert.equal(calls[9][0], "attribution");
  assert.equal(calls[9][1].lead.id, 707);
  assert.equal(calls[9][1].incoming.attribution.source, "instagram_comment");
  assert.equal(calls[9][1].incoming.attribution.sourceId, "m-7");
  assert.match(calls[9][1].incoming.attribution.headline, /Skin consultation promotion/);
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
  const existing = { id: 808, contact_id: 108, whatsapp_message_id: "facebook:dm-8" };
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
  assert.deepEqual(calls[1], ["lookup", 108, "facebook:dm-8"]);
  assert.deepEqual(calls[2].slice(0, 4), ["lead", 108, "Comment Automation", 808]);
});

test("preserves pending comment DM reservation when Meta accepted but checkpointing the MID fails", async () => {
  const stored = {
    id: 70,
    channel: "instagram",
    commentId: "c-70",
    entryId: "ig-business",
    authorId: "igsid-70",
    authorName: "Alicia",
    text: "Price?",
    postId: null,
    mediaId: "m-70",
    parentCommentId: null,
    sourceCreatedAt: new Date().toISOString(),
    rawEvent: {},
    attemptCount: 1,
    publicReplyId: null,
    privateReplyMessageId: null,
  };

  let reserved = false;
  let preservedFailure = false;
  const repo = {
    claimJob: async () => stored,
    markPrivateReplyPending: async (_id, data) => {
      reserved = true;
      return { ...stored, privateReplyPendingText: data.text };
    },
    markPrivateReplySent: async () => {
      throw new Error("database checkpoint failed");
    },
    markFailedPreservingPrivateReplyPending: async (id, err, attemptCount) => {
      assert.equal(id, stored.id);
      assert.match(err.message, /checkpoint failed/);
      assert.equal(attemptCount, 1);
      preservedFailure = true;
      return { ...stored, status: "failed", privateReplyPendingText: "DM copy" };
    },
    markFailed: async () => assert.fail("accepted Meta send must retain the reservation"),
    markCompleted: async () => assert.fail("job should not complete"),
    markSkipped: async () => assert.fail("job should not skip"),
    listRecoverable: async () => [],
  };
  const meta = {
    fetchCommentSourceContext: async () => null,
    sendPrivateReplyToComment: async () => {
      assert.equal(reserved, true);
      return {
        success: true,
        alreadySent: false,
        messageId: "ig-accepted-mid",
        recipientId: "igsid-70",
      };
    },
  };
  const aiClient = {
    getReply: async () => JSON.stringify({
      reply: "DM copy",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
      projectLocation: null,
      projectSummary: null,
      nextStep: null,
      publicReply: "",
      privateReply: "DM copy",
      shouldRespond: true,
    }),
  };
  const config = {
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      enabled: true,
      publicReplyEnabled: false,
      privateReplyEnabled: true,
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

  const result = await service.processJob(stored.id);
  assert.equal(preservedFailure, true);
  assert.equal(result.status, "failed");
});

test("clears pending comment DM reservation through normal failure path when Meta rejects the send", async () => {
  const stored = {
    id: 71,
    channel: "facebook",
    commentId: "c-71",
    entryId: "page-71",
    authorId: "psid-71",
    authorName: "Ben",
    text: "More info?",
    postId: "page-71_post-71",
    mediaId: null,
    parentCommentId: null,
    sourceCreatedAt: new Date().toISOString(),
    rawEvent: {},
    attemptCount: 1,
    publicReplyId: null,
    privateReplyMessageId: null,
  };

  let normalFailure = false;
  const repo = {
    claimJob: async () => stored,
    markPrivateReplyPending: async (_id, data) => ({
      ...stored,
      privateReplyPendingText: data.text,
    }),
    markPrivateReplySent: async () => assert.fail("rejected send must not checkpoint"),
    markFailedPreservingPrivateReplyPending: async () =>
      assert.fail("rejected Meta send must not preserve the reservation"),
    markFailed: async (id, err, attemptCount) => {
      assert.equal(id, stored.id);
      assert.match(err.message, /Meta rejected private reply/);
      assert.equal(attemptCount, 1);
      normalFailure = true;
      return {
        ...stored,
        status: "failed",
        privateReplyPendingText: null,
        privateReplyPendingAt: null,
      };
    },
    markCompleted: async () => assert.fail("job should not complete"),
    markSkipped: async () => assert.fail("job should not skip"),
    listRecoverable: async () => [],
  };
  const meta = {
    fetchCommentSourceContext: async () => null,
    sendPrivateReplyToComment: async () => ({
      success: false,
      alreadySent: false,
      messageId: null,
      recipientId: null,
      error: "Meta rejected private reply",
    }),
  };
  const aiClient = {
    getReply: async () => JSON.stringify({
      reply: "DM copy",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
      projectLocation: null,
      projectSummary: null,
      nextStep: null,
      publicReply: "",
      privateReply: "DM copy",
      shouldRespond: true,
    }),
  };
  const config = {
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      enabled: true,
      publicReplyEnabled: false,
      privateReplyEnabled: true,
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

  const result = await service.processJob(stored.id);
  assert.equal(normalFailure, true);
  assert.equal(result.status, "failed");
  assert.equal(result.privateReplyPendingText, null);
});



test("urgent comment safety bypasses AI, overrides fixed promo copy, and flags staff before Meta sends", async () => {
  const calls = [];
  const stored = {
    id: 90,
    channel: "instagram",
    commentId: "c-90",
    entryId: "ig-business",
    authorId: "igsid-90",
    authorName: "Alicia",
    text: "I can't breathe and it's getting worse",
    postId: null,
    mediaId: "m-90",
    parentCommentId: null,
    sourceCreatedAt: new Date().toISOString(),
    rawEvent: {},
    attemptCount: 1,
    publicReplyId: null,
    privateReplyMessageId: null,
  };

  const repo = {
    claimJob: async () => stored,
    markPublicReplySent: async (_id, replyId) => ({
      ...stored,
      publicReplyId: replyId,
    }),
    markPrivateReplyPending: async (_id, data) => ({
      ...stored,
      publicReplyId: "pub-90",
      privateReplyPendingText: data.text,
    }),
    markPrivateReplySent: async (_id, data) => ({
      ...stored,
      publicReplyId: "pub-90",
      privateReplyMessageId: data.messageId,
      privateReplyRecipientId: data.recipientId,
    }),
    markCompleted: async () => ({ ...stored, status: "completed" }),
    markFailed: async (_id, err) => assert.fail(`urgent comment should not fail: ${err?.message}`),
    markSkipped: async () => assert.fail("urgent comment should not skip"),
    listRecoverable: async () => [],
  };

  const meta = {
    fetchCommentSourceContext: async () => null,
    replyToComment: async (_channel, _id, text) => {
      calls.push(["public", text]);
      return { success: true, replyId: "pub-90" };
    },
    sendPrivateReplyToComment: async (_channel, _id, text) => {
      calls.push(["private", text]);
      return {
        success: true,
        messageId: "dm-90",
        recipientId: "igsid-90",
      };
    },
  };

  const aiClient = {
    getReply: async () => assert.fail("urgent deterministic comment must not call AI"),
  };

  const contacts = {
    getOrCreateChannelContact: async (...args) => {
      calls.push(["contact", ...args]);
      return { id: 190, mode: "ai" };
    },
    setAttention: async (contactId, needsAttention, reason) => {
      calls.push(["attention", contactId, needsAttention, reason]);
    },
  };
  const handoff = async (contactId, reason) => {
    calls.push(["handoff", contactId, reason]);
    return { id: contactId, mode: "human", needs_attention: true };
  };

  const messages = {
    getMessageByProviderIdForContact: async () => null,
  };
  const store = {
    appendMessageForContact: async () => ({ id: 290 }),
  };
  const pipeline = {
    ensureLeadForContact: async () => ({ created: false, lead: null }),
  };

  const config = {
    escalation: {
      handoffMessage: "A team member will follow up.",
    },
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      enabled: true,
      publicReplyStyle: "fixed",
      fixedPublicReply: "SALE SALE SALE",
      activatedAt: new Date(Date.now() - 1000).toISOString(),
    },
  };

  const safetyCopy = deterministicCommentSafetyCopy(
    {
      channel: stored.channel,
      text: stored.text,
    },
    config.commentAutomation,
    config
  );
  assert.equal(safetyCopy.urgentSafety, true);
  assert.match(safetyCopy.privateReply, /urgent medical attention/i);

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
    handoff,
  });

  await service.processJob(stored.id);

  const firstHandoff = calls.findIndex((call) => call[0] === "handoff");
  const firstPublic = calls.findIndex((call) => call[0] === "public");
  const firstPrivate = calls.findIndex((call) => call[0] === "private");
  assert.ok(firstHandoff >= 0);
  assert.ok(firstPublic > firstHandoff, "Staff-mode handoff should be persisted before public reply");
  assert.ok(firstPrivate > firstPublic, "private urgent guidance should follow the safe public reply");
  assert.equal(calls[firstHandoff][1], 190);

  const publicReply = calls[firstPublic][1];
  const privateReply = calls[firstPrivate][1];
  assert.doesNotMatch(publicReply, /SALE SALE SALE/);
  assert.match(publicReply, /contact the clinic directly now/i);
  assert.match(privateReply, /urgent medical attention/i);
  assert.match(privateReply, /emergency medical care immediately/i);
});


test("urgent public-only comment copy includes emergency guidance when private replies are disabled", () => {
  const config = {
    escalation: { handoffMessage: "A team member will follow up." },
    commentAutomation: {
      ...DEFAULT_COMMENT_AUTOMATION,
      privateReplyEnabled: false,
    },
  };

  const english = deterministicCommentSafetyCopy(
    { channel: "facebook", text: "I can't breathe and it's getting worse" },
    config.commentAutomation,
    config
  );
  assert.equal(english.urgentSafety, true);
  assert.match(english.publicReply, /emergency medical care immediately/i);

  const malay = deterministicCommentSafetyCopy(
    { channel: "facebook", text: "saya susah bernafas" },
    config.commentAutomation,
    config
  );
  assert.match(malay.publicReply, /rawatan kecemasan segera/i);

  const chinese = deterministicCommentSafetyCopy(
    { channel: "instagram", text: "我呼吸困难而且越来越严重" },
    config.commentAutomation,
    config
  );
  assert.match(chinese.publicReply, /紧急医疗帮助/u);
});

test("global automation pause still stores and hands off urgent comments without sending customer replies", async () => {
  const calls = [];
  const urgentJob = {
    id: 91,
    channel: "facebook",
    commentId: "c-91",
    entryId: "page-91",
    authorId: "psid-91",
    authorName: "Jane",
    text: "I have chest pain and can't breathe",
    postId: "page-91_post-91",
    mediaId: null,
    parentCommentId: null,
    sourceCreatedAt: new Date().toISOString(),
    rawEvent: {},
    attemptCount: 1,
    publicReplyId: null,
    privateReplyMessageId: null,
  };

  const repo = {
    storeIncomingComment: async (event) => {
      calls.push(["store", event.text]);
      return { ...urgentJob, ...event, id: urgentJob.id };
    },
    claimJob: async () => urgentJob,
    markSkipped: async (_id, reason) => {
      calls.push(["skipped", reason]);
      return { ...urgentJob, status: "skipped", lastError: reason };
    },
    markFailed: async () => assert.fail("paused urgent comment should not fail"),
    listRecoverable: async () => [],
  };
  const meta = {
    fetchCommentSourceContext: async () => assert.fail("paused safety path should not fetch context"),
    replyToComment: async () => assert.fail("paused safety path must not send a public reply"),
    sendPrivateReplyToComment: async () => assert.fail("paused safety path must not send a DM"),
  };
  const aiClient = {
    getReply: async () => assert.fail("paused safety path must not call AI"),
  };
  const contacts = {
    getOrCreateChannelContact: async (...args) => {
      calls.push(["contact", ...args]);
      return { id: 191, mode: "ai" };
    },
    setAttention: async () => assert.fail("AI-owned urgent contact should use synthetic handoff"),
  };
  const handoff = async (contactId, reason) => {
    calls.push(["handoff", contactId, reason]);
    return { id: contactId, mode: "human", needs_attention: true };
  };
  const config = {
    escalation: { handoffMessage: "A team member will follow up." },
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
    config,
    repliesEnabled: () => false,
    handoff,
  });

  const body = {
    object: "page",
    entry: [{
      id: "page-91",
      changes: [
        {
          field: "feed",
          value: {
            item: "comment",
            verb: "add",
            comment_id: "c-91",
            post_id: "page-91_post-91",
            parent_id: "page-91_post-91",
            message: urgentJob.text,
            from: { id: "psid-91", name: "Jane" },
          },
        },
        {
          field: "feed",
          value: {
            item: "comment",
            verb: "add",
            comment_id: "c-normal",
            post_id: "page-91_post-91",
            parent_id: "page-91_post-91",
            message: "How much is this?",
            from: { id: "psid-normal", name: "Normal" },
          },
        },
      ],
    }],
  };

  const accepted = await service.acceptIncomingComments(body);
  assert.equal(accepted.length, 1);
  assert.deepEqual(calls.filter((call) => call[0] === "store").map((call) => call[1]), [
    urgentJob.text,
  ]);

  const result = await service.processJob(urgentJob.id);
  assert.equal(result.status, "skipped");
  assert.ok(calls.some((call) => call[0] === "handoff" && call[1] === 191));
  assert.match(
    calls.find((call) => call[0] === "skipped")[1],
    /safety comment was flagged for staff/i
  );
});
