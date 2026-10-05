const test = require("node:test");
const assert = require("node:assert/strict");

const messagesRepo = require("../src/db/messagesRepo");
const realtimeEvents = require("../src/utils/realtimeEvents");
const staffOwnershipService = require("../src/services/staffOwnershipService");
const conversationStore = require("../src/utils/conversationStore");

test("claims an AI handoff before saving the first staff-authored message", async (t) => {
  const originalClaim = staffOwnershipService.claimAiHandoffOwnership;
  const originalSave = messagesRepo.saveMessage;
  const order = [];

  t.after(() => {
    staffOwnershipService.claimAiHandoffOwnership = originalClaim;
    messagesRepo.saveMessage = originalSave;
  });

  staffOwnershipService.claimAiHandoffOwnership = async (contactId, username) => {
    order.push(`claim:${contactId}:${username}`);
    return { id: contactId, mode: "human", takeover_by: username };
  };
  messagesRepo.saveMessage = async (contactId, role, content, _wamid, sentByUsername) => {
    order.push(`save:${contactId}:${sentByUsername}`);
    return {
      id: 501,
      contact_id: contactId,
      role,
      content,
      sent_by_username: sentByUsername,
    };
  };

  const saved = await conversationStore.appendMessageForContact(
    42,
    "assistant",
    "Staff reply",
    null,
    "caden",
    null,
    null,
    { publish: false }
  );

  assert.equal(saved.id, 501);
  assert.deepEqual(order, [
    "claim:42:caden",
    "save:42:caden",
  ]);
});

test("publishes an updated inbound row so the Inbox does not need a refresh", async (t) => {
  const originalUpdateInboundMessage = messagesRepo.updateInboundMessage;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    messagesRepo.updateInboundMessage = originalUpdateInboundMessage;
    realtimeEvents.publish = originalPublish;
  });

  const updated = {
    id: 42,
    contact_id: 7,
    role: "user",
    content: "📷 Updated caption",
    has_media_attachment: true,
    media_mime_type: "image/jpeg",
  };
  const published = [];

  messagesRepo.updateInboundMessage = async (...args) => {
    assert.deepEqual(args, [42, 7, "📷 Updated caption", "base64-data", "image/jpeg"]);
    return updated;
  };
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const result = await conversationStore.updateInboundMessage(
    7,
    42,
    "📷 Updated caption",
    { data: "base64-data", mimeType: "image/jpeg" }
  );

  assert.equal(result, updated);
  assert.deepEqual(published, [
    {
      event: "conversation_changed",
      payload: {
        contactId: 7,
        messageId: 42,
        message: updated,
        reason: "message_updated",
      },
    },
  ]);
});


test("does not send WhatsApp sticker artwork into AI vision context", async (t) => {
  const originalGetPage = messagesRepo.getMessagePageForContact;
  const originalGetMedia = messagesRepo.getMessageMediaForContact;
  const mediaReads = [];

  t.after(() => {
    messagesRepo.getMessagePageForContact = originalGetPage;
    messagesRepo.getMessageMediaForContact = originalGetMedia;
  });

  messagesRepo.getMessagePageForContact = async () => ({
    rows: [
      {
        id: 70,
        contact_id: 7,
        role: "user",
        content: "🙂 [Customer sent a sticker]",
        has_media_attachment: true,
        media_mime_type: "image/webp",
        delivery_status: null,
      },
      {
        id: 71,
        contact_id: 7,
        role: "user",
        content: "Can I know the price?",
        has_media_attachment: false,
        media_mime_type: null,
        delivery_status: null,
      },
    ],
    hasMore: false,
  });

  messagesRepo.getMessageMediaForContact = async (...args) => {
    mediaReads.push(args);
    return {
      media_mime_type: "image/webp",
      media_base64: "sticker-bytes",
    };
  };

  const history = await conversationStore.getHistoryForContact(7, {
    throughMessageId: 71,
  });

  assert.deepEqual(history, [
    { role: "user", content: "🙂 [Customer sent a sticker]" },
    { role: "user", content: "Can I know the price?" },
  ]);
  assert.deepEqual(
    mediaReads,
    [],
    "sticker artwork must not be loaded into the AI vision prompt"
  );
});
