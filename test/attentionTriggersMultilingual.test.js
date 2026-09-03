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

test("ordinary Malay clinic questions are not treated as deterministic emergencies", () => {
  assert.equal(checkKeywordTriggers("berapa harga hifu untuk muka"), null);
  assert.equal(checkKeywordTriggers("boleh buat appointment sabtu petang"), null);
});
