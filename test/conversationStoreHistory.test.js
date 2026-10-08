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
test("AI excludes cancelled and pending-unsent pricing messages from both history modes", async (t) => {
  const originalPage = messagesRepo.getMessagePageForContact;
  const originalRecent = messagesRepo.getMessagesForContact;
  t.after(() => {
    messagesRepo.getMessagePageForContact = originalPage;
    messagesRepo.getMessagesForContact = originalRecent;
  });
  const rows = [
    { id: 1, role: "user", content: "How much?", has_media_attachment: false },
    { id: 2, role: "assistant", content: "Unsеnt RM388 graphic", pricing_reminder_anchor_id: 44, delivery_status: null },
    { id: 3, role: "assistant", content: "Cancelled RM388 graphic", pricing_reminder_anchor_id: 44, delivery_status: "cancelled" },
    { id: 4, role: "assistant", content: "Failed", delivery_status: "failed" },
    { id: 5, role: "assistant", content: "Unknown", delivery_status: "unknown" },
    { id: 6, role: "assistant", content: "Follow-up 3 testimonial", delivery_status: "delivered" },
    { id: 7, role: "assistant", content: "Actual price sent", pricing_reminder_anchor_id: 44, delivery_status: "sent" },
  ];
  messagesRepo.getMessagePageForContact = async () => ({ rows, hasMore: false });
  messagesRepo.getMessagesForContact = async () => rows;
  const expected = [
    { role:"user", content:"How much?" },
    { role:"assistant", content:"Follow-up 3 testimonial" },
    { role:"assistant", content:"Actual price sent" },
  ];
  assert.deepEqual(await conversationStore.getHistoryForContact(42,{throughMessageId:7}),expected);
  assert.deepEqual(await conversationStore.getHistoryForContact(42),expected);
});

test("AI history SQL excludes unsent pricing claims before loading the 20-message window", async(t)=>{
  const {pool}=require("../src/db/db");
  const original=pool.query;
  t.after(()=>{pool.query=original});
  let sql="";
  pool.query=async (query)=>{sql=query;return {rows:[]}};
  const messages=await messagesRepo.getMessagesForContact(42,20,false);
  assert.deepEqual(messages,[]);
  assert.match(sql,/NOT IN \('failed', 'unknown', 'cancelled'\)/);
  assert.match(sql,/pricing_reminder_anchor_id IS NOT NULL/);
  assert.match(sql,/delivery_status IS NULL OR delivery_status = 'cancelled'/);
});
