const test = require("node:test");
const assert = require("node:assert/strict");

const {
  URGENT_SAFETY_REASON,
  checkKeywordTriggers,
  isUrgentSafetyMessage,
} = require("../src/utils/attentionTriggers");

test("high-confidence Bahasa Malaysia safety/handoff phrases trigger staff attention", () => {
  assert.ok(checkKeywordTriggers("saya nak cakap dengan staff"));
  assert.ok(checkKeywordTriggers("sakit sangat dan makin sakit"));
  assert.ok(checkKeywordTriggers("saya susah bernafas"));
  assert.equal(checkKeywordTriggers("sakit dada sekarang"), URGENT_SAFETY_REASON);
  assert.equal(checkKeywordTriggers("bengkak makin teruk dan merebak"), URGENT_SAFETY_REASON);
});

test("high-confidence Chinese safety/handoff phrases trigger staff attention", () => {
  assert.ok(checkKeywordTriggers("我要真人客服"));
  assert.ok(checkKeywordTriggers("越来越痛而且越来越严重"));
  assert.ok(checkKeywordTriggers("呼吸困难"));
  assert.equal(checkKeywordTriggers("现在胸口痛"), URGENT_SAFETY_REASON);
  assert.equal(checkKeywordTriggers("伤口流脓而且发烧"), URGENT_SAFETY_REASON);
});

test("English urgent safety coverage uses the same detector as staff attention", () => {
  for (const message of [
    "I can't breathe properly",
    "I'm having vision changes",
    "the skin is blanching",
    "I have chest pain",
    "the bleeding won't stop",
    "there is pus and I have a fever",
    "the swelling is getting worse",
  ]) {
    assert.equal(isUrgentSafetyMessage(message), true, message);
    assert.equal(checkKeywordTriggers(message), URGENT_SAFETY_REASON, message);
  }
});

test("ordinary clinic and pre-treatment questions are not deterministic emergencies", () => {
  assert.equal(checkKeywordTriggers("berapa harga hifu untuk muka"), null);
  assert.equal(checkKeywordTriggers("boleh buat appointment sabtu petang"), null);
  assert.equal(checkKeywordTriggers("hifu sakit sangat ke?"), null);
  assert.equal(checkKeywordTriggers("HIFU会很痛吗？"), null);
  assert.equal(checkKeywordTriggers("这个会非常痛吗?"), null);
  assert.equal(checkKeywordTriggers("Is swelling normal after treatment?"), null);
  assert.equal(checkKeywordTriggers("Can this treatment cause fever?"), null);
  assert.equal(checkKeywordTriggers("Will there be bleeding?"), null);
});
