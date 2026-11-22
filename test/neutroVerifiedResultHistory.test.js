"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const messagesRepo = require("../src/db/messagesRepo");
const conversationStore = require("../src/utils/conversationStore");
const { verifiedResultExampleForConversation } = require("../src/utils/verifiedResultMediaExample");

test("saved outgoing image evidence reaches result verification but never model serialization", async () => {
  const old = messagesRepo.getMessagePageForContact;
  try {
    messagesRepo.getMessagePageForContact = async () => ({
      hasMore: false,
      rows: [
        { id:21, role:"assistant",
          content:"再给你看一个顾客护理后的 Before & After 😊",
          media_url:"/api/config/result-media/image/12",
          delivery_status:"read", sent_by_username:null },
        { id:22, role:"user", content:"一次就这样的效果？",
          media_url:null, delivery_status:"received" },
      ],
    });
    const history = await conversationStore.getHistoryForContact(25, {throughMessageId:22});
    assert.equal(history.length,2);
    assert.equal(history[0].verifiedOutboundImageUrl,"/api/config/result-media/image/12");
    assert.equal(history[1].verifiedOutboundImageUrl,null);
    assert.equal(Object.prototype.propertyIsEnumerable.call(history[0],"verifiedOutboundImageUrl"),false);
    assert.doesNotMatch(JSON.stringify(history),/verifiedOutboundImageUrl|resultMediaImage/);
    const example = verifiedResultExampleForConversation({
      messages:history,customerText:"一次就这样的效果？",
      resultMedia:[{service:"骨盆调理",enabled:true,items:[{
        caption:"再给你看一个顾客护理后的 Before & After 😊",
        imageUrl:"/api/config/result-media/image/12",
        verifiedSessionCount:1,
        verifiedSessionImageUrl:"/api/config/result-media/image/12",
      }]}],
    });
    assert.deepEqual(example,{service:"骨盆调理",verifiedSessionCount:1});
  } finally {
    messagesRepo.getMessagePageForContact = old;
  }
});
