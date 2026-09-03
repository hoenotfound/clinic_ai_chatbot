const test = require("node:test");
const assert = require("node:assert/strict");

const messagesRepo = require("../src/db/messagesRepo");
const conversationStore = require("../src/utils/conversationStore");

test("AI history can be bounded to the final message in the current debounce burst", async (t) => {
  const originalPage = messagesRepo.getMessagePageForContact;
  const originalRecent = messagesRepo.getMessagesForContact;
  const originalMedia = messagesRepo.getMessageMediaForContact;
  t.after(() => {
    messagesRepo.getMessagePageForContact = originalPage;
    messagesRepo.getMessagesForContact = originalRecent;
    messagesRepo.getMessageMediaForContact = originalMedia;
  });

  let pageOptions = null;
  messagesRepo.getMessagePageForContact = async (contactId, options) => {
    assert.equal(contactId, 42);
    pageOptions = options;
    return {
      rows: [
        { id: 98, role: "user", content: "hi", has_media_attachment: false },
        { id: 99, role: "assistant", content: "failed send", delivery_status: "failed", has_media_attachment: false },
        { id: 100, role: "user", content: "how much hifu", has_media_attachment: false },
      ],
      hasMore: false,
    };
  };
  messagesRepo.getMessagesForContact = async () => {
    throw new Error("unbounded history path should not be used");
  };
  messagesRepo.getMessageMediaForContact = async () => null;

  const history = await conversationStore.getHistoryForContact(42, {
    throughMessageId: 100,
  });

  assert.deepEqual(pageOptions, {
    limit: 20,
    beforeId: 101,
    includeMedia: false,
  });
  assert.deepEqual(history, [
    { role: "user", content: "hi" },
    { role: "user", content: "how much hifu" },
  ]);
});