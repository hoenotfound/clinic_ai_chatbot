const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GEMINI_MODEL,
  parseTranslations,
} = require("../src/services/followUpTranslationService");

test("follow-up translation defaults to current Gemini 3.6 Flash instead of retired 2.5", () => {
  assert.equal(GEMINI_MODEL, "gemini-3.6-flash");
});

test("parses the three stored follow-up language versions", () => {
  assert.deepEqual(
    parseTranslations(
      '```json\n{"en":"Hello 😊","ms":"Hai 😊","zh":"您好 😊"}\n```'
    ),
    { en: "Hello 😊", ms: "Hai 😊", zh: "您好 😊" }
  );
});

test("rejects incomplete translated messages", () => {
  assert.throws(
    () => parseTranslations('{"en":"Hello","ms":"Hai"}'),
    /empty or too long/
  );
});
