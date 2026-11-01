"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {localizedFollowUpText}=require("../src/services/whatsappSecondaryFollowUpLanguage");
const chinese="你之前咨询的护理，如果还有哪里想了解的，我可以帮你整理一下 😊";
test("2h and 6h followups honor the customer's evidenced language",()=>{
 for(const slot of [2,6]){
  const en=localizedFollowUpText({slot,originalText:chinese,
   customerTexts:["How much is the treatment?"]});
  assert.match(en,/treatment/i);
  assert.doesNotMatch(en,/你/);
  const ms=localizedFollowUpText({slot,originalText:chinese,
   customerTexts:["Saya nak tahu harga rawatan"]});
  assert.match(ms,/rawatan/i);
  assert.doesNotMatch(ms,/你/);
  assert.equal(localizedFollowUpText({slot,originalText:chinese,
   customerTexts:["你好我想了解骨盆调理"]}),chinese);
 }
});
test("preceding context is used when the last message is 'ok' or 'price'",()=>{
 const text=localizedFollowUpText({slot:2,originalText:chinese,
  customerTexts:["price","Saya nak tahu harga"]});
 assert.match(text,/rawatan/);
});
test("no language evidence does not spend a follow-up attempt",()=>{
 assert.equal(localizedFollowUpText({slot:2,originalText:chinese,
  customerTexts:["ok","hi"]}),null);
 assert.equal(localizedFollowUpText({slot:6,originalText:chinese,
  customerTexts:[]}),null);
});
test("20h AI content is unaffected by localization",()=>{
 const text="AI personalized message";
 assert.equal(localizedFollowUpText({slot:20,originalText:text,customerTexts:[]}),text);
});
