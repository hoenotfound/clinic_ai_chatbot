const test = require("node:test");
const assert = require("node:assert/strict");

const { checkKeywordTriggers } = require("../src/utils/attentionTriggers");

test("high-confidence Bahasa Malaysia safety/handoff phrases trigger staff attention", () => {
  assert.ok(checkKeywordTriggers("saya nak cakap dengan staff"));
  assert.ok(checkKeywordTriggers("sakit sangat dan makin sakit"));
  assert.ok(checkKeywordTriggers("saya susah bernafas"));
});

test("high-confidence Chinese safety/handoff phrases trigger staff attention", () => {
  assert.ok(checkKeywordTriggers("我要真人客服"));
  assert.ok(checkKeywordTriggers("越来越痛而且越来越严重"));
  assert.ok(checkKeywordTriggers("呼吸困难"));
});

test("ordinary clinic and pre-treatment pain questions are not deterministic emergencies", () => {
  assert.equal(checkKeywordTriggers("berapa harga hifu untuk muka"), null);
  assert.equal(checkKeywordTriggers("boleh buat appointment sabtu petang"), null);
  assert.equal(checkKeywordTriggers("hifu sakit sangat ke?"), null);
  assert.equal(checkKeywordTriggers("HIFU会很痛吗？"), null);
  assert.equal(checkKeywordTriggers("这个会非常痛吗?"), null);
});
