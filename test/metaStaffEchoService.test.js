const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const commentRepo = require("../src/db/metaCommentAutomationRepo");
const aiReplyCancellation = require("../src/services/aiReplyCancellationService");
const service = require("../src/services/metaStaffEchoService");

test("early comment automation echo is not treated as manual staff activity", async (t) => {
  const originalRecord = commentRepo.recordPendingPrivateReplyEcho;
  const originalContact = contactsRepo.getOrCreateChannelContact;
  t.after(() => {
    commentRepo.recordPendingPrivateReplyEcho = originalRecord;
    contactsRepo.getOrCreateChannelContact = originalContact;
  });

  const echo = {
    id: "ig-comment-dm-mid",
    channel: "instagram",
    to: "igsid-commenter",
    text: "Hi! Which area are you asking about?",
    mediaType: null,
    isDeleted: false,
  };

  const key = aiReplyCancellation.keyForChannelContact(echo.channel, echo.to);
  const token = aiReplyCancellation.snapshot(key);
  service.beginPendingAiForEcho(echo);
  assert.equal(aiReplyCancellation.hasPendingEcho(key), true);

  let captured = null;
  commentRepo.recordPendingPrivateReplyEcho = async (payload) => {
    captured = payload;
    return { id: 77, privateReplyMessageId: echo.id };
  };
  contactsRepo.getOrCreateChannelContact = async () => {
    assert.fail("comment automation echo must be consumed before contact takeover logic");
  };

  const result = await service.persistStaffEcho(echo, { pendingStarted: true });

  assert.equal(result, null);
  assert.deepEqual(captured, {
    channel: "instagram",
    recipientId: "igsid-commenter",
    text: "Hi! Which area are you asking about?",
    messageId: "ig-comment-dm-mid",
  });
  assert.equal(aiReplyCancellation.hasPendingEcho(key), false);
  assert.equal(aiReplyCancellation.cancelledSince(key, token), false);
});
