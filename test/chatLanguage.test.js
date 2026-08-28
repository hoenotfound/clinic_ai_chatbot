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
  assert.equal(detectMessageLanguage("请问这个疗程多少钱？"), "zh");
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
