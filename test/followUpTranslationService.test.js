const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTranslations } = require("../src/services/followUpTranslationService");

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
