const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isUnanswerableCustomerReply,
} = require("../src/utils/aiSilentReviewPolicy");
const {
  checkKeywordTriggers,
  isUrgentSafetyMessage,
  isActiveSafetyConcern,
  isExplicitStaffRequest,
} = require("../src/utils/attentionTriggers");
const { categorizeAiReview, followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");

test("unable-to-answer responses become private reviews in Chinese, English and Malay", () => {
  for (const reply of [
    "Sorry, I can't answer that question.",
    "I am unable to help with this.",
    "I'll check with our staff for you.",
    "不好意思，我无法回答这个问题。",
    "这个需要让我问同事确认。",
    "Maaf, saya tak dapat jawab itu.",
  ]) {
    assert.equal(isUnanswerableCustomerReply(reply, "Price?"), true, reply);
  }
});

test("normal helpful replies and service limits must not be silently dropped", () => {
  for (const reply of [
    "可以呀～我们骨盆调理目前有优惠配套哦 😊",
    "Sorry, we're closed on Monday, but Tuesday is available.",
    "We don't offer a home visit, but you can come to PJ.",
    "不好意思，今天已经约满了。星期二可以哦。",
    "Our team can help schedule an appointment.",
    "Sorry to hear that. Please tell me more about what happened.",
  ]) {
    assert.equal(isUnanswerableCustomerReply(reply, "Hi"), false, reply);
  }
});

test("customer questions about bot identity may receive an honest answer", () => {
  assert.equal(
    isUnanswerableCustomerReply("As an AI chat assistant, I can help with your booking.", "Are you an AI?"),
    false
  );
  assert.equal(
    isUnanswerableCustomerReply("As an AI chat assistant, I can help with your booking.", "What is the price?"),
    true
  );
});

test("explicit staff requests are separated from medical safety and normal unknowns", () => {
  for (const text of ["我要找真人客服", "转人工", "I'd like to speak with a real person", "Nak cakap dengan staff"]) {
    assert.equal(isExplicitStaffRequest(text), true, text);
    assert.ok(checkKeywordTriggers(text), text);
  }
  for (const text of ["Can you tell me about 骨盆调理?", "How much is 9D?", "I don't know the address"]) {
    assert.equal(isExplicitStaffRequest(text), false, text);
  }
  assert.equal(isActiveSafetyConcern("I am having side effects"), true);
  assert.equal(isUrgentSafetyMessage("I can't breathe"), true);
  assert.equal(isActiveSafetyConcern("Is it painful?"), false);
});

test("technical review is categorized non-clinically, clinical unknowns remain blocked", () => {
  assert.equal(categorizeAiReview("Price?", "information"), "information");
  assert.equal(categorizeAiReview("I'm pregnant, can I do 9D?", "information"), "clinical");
  const sql = followUpAttentionAllowedSql("c");
  assert.match(sql, /attention_reason LIKE 'AI review requested:%'/);
  assert.match(sql, /category <> 'information'/);
});
