const test = require("node:test");
const assert = require("node:assert/strict");

const messagesRepo = require("../src/db/messagesRepo");
const realtimeEvents = require("../src/utils/realtimeEvents");
const conversationStore = require("../src/utils/conversationStore");

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
