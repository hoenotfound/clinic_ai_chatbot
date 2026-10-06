const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");
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


test("deleted Meta staff echo retry is ignored before recreating the contact", async (t) => {
  const originalRecord = commentRepo.recordPendingPrivateReplyEcho;
  const originalDeletedCheck = inboundProcessingRepo.isDeletedProviderMessageId;
  const originalContact = contactsRepo.getOrCreateChannelContact;
  t.after(() => {
    commentRepo.recordPendingPrivateReplyEcho = originalRecord;
    inboundProcessingRepo.isDeletedProviderMessageId = originalDeletedCheck;
    contactsRepo.getOrCreateChannelContact = originalContact;
  });

  const echo = {
    id: "mid-deleted-staff",
    channel: "facebook",
    to: "psid-deleted",
    text: "Old staff retry",
    mediaType: null,
    isDeleted: false,
  };

  const key = aiReplyCancellation.keyForChannelContact(echo.channel, echo.to);
  service.beginPendingAiForEcho(echo);

  commentRepo.recordPendingPrivateReplyEcho = async () => null;
  inboundProcessingRepo.isDeletedProviderMessageId = async (providerMessageId) => {
    assert.equal(providerMessageId, "facebook:mid-deleted-staff");
    return true;
  };
  contactsRepo.getOrCreateChannelContact = async () => {
    assert.fail("deleted Meta staff echo retry must not recreate a contact");
  };

  const result = await service.persistStaffEcho(echo, { pendingStarted: true });

  assert.equal(result, null);
  assert.equal(aiReplyCancellation.hasPendingEcho(key), false);
});
