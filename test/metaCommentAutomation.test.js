const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
    getReply: async () => JSON.stringify({
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
    }),
  };
  const contacts = {
    getOrCreateChannelContact: async (...args) => {
      calls.push(["contact", ...args]);
      return { id: 99 };
    },
    setAttention: async () => {},
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
      return { created: true };
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
    pipeline,
    store,
    config,
    repliesEnabled: () => true,
  });

  await service.processJob(stored.id);

  assert.equal(calls[0][0], "public");
  assert.equal(calls[1][0], "private");
  assert.deepEqual(calls[2].slice(0, 4), ["contact", "instagram", "igsid-77", "Alicia"]);
  assert.equal(calls[3][0], "message");
  assert.deepEqual(calls[4].slice(0, 3), ["lead", 99, "Comment Automation"]);
});
