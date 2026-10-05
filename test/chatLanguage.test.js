const test = require("node:test");
const assert = require("node:assert/strict");

const {
  detectMessageLanguage,
  detectConversationLanguage,
} = require("../src/utils/chatLanguage");

test("detects English, Bahasa Malaysia, and Chinese customer messages", () => {
  assert.equal(detectMessageLanguage("How much is this treatment?"), "en");
  assert.equal(detectMessageLanguage("Boleh tahu berapa harga rawatan ini?"), "ms");
  assert.equal(detectMessageLanguage("Price berapa?"), "ms");
  assert.equal(detectMessageLanguage("Berkesan ke?"), "ms");
  assert.equal(detectMessageLanguage("请问这个疗程多少钱？"), "zh");
});

test("does not mistake Malaysian-English ya for Bahasa Malaysia", () => {
  assert.equal(
    detectMessageLanguage("Busy now. Will msg you after ya"),
    "en"
  );
  assert.equal(detectMessageLanguage("Can later ya"), "en");
  assert.equal(detectMessageLanguage("ok ya"), null);

  // Real Malay signals still win in code-mixed messages.
  assert.equal(detectMessageLanguage("Price berapa?"), "ms");
  assert.equal(detectMessageLanguage("Nak tahu harga ya"), "ms");
});

test("an ambiguous ya-only reply inherits earlier conversation language", () => {
  assert.equal(
    detectConversationLanguage(["ok ya", "How much is this treatment?"]),
    "en"
  );
  assert.equal(
    detectConversationLanguage(["ok ya", "Boleh tahu berapa harga rawatan ini?"]),
    "ms"
  );
});

test("uses an earlier meaningful message when the newest reply is ambiguous", () => {
  assert.equal(
    detectConversationLanguage(["ok", "Saya nak tanya harga rawatan ini"]),
    "ms"
  );
});

test("falls back to English when no recent message reveals a language", () => {
  assert.equal(detectConversationLanguage(["👍", "ok"]), "en");
});
