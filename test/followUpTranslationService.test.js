const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GEMINI_MODEL,
  MAX_PROVIDER_BATCH_MESSAGES,
  MAX_PROVIDER_BATCH_SOURCE_CHARS,
  chunkProviderMessages,
  parseTranslationBatch,
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


test("parses batched follow-up translations in input order", () => {
  assert.deepEqual(
    parseTranslationBatch(
      '{"items":[{"index":1,"en":"Second","ms":"Kedua","zh":"第二"},{"index":0,"en":"First","ms":"Pertama","zh":"第一"}]}',
      2
    ),
    [
      { en: "First", ms: "Pertama", zh: "第一" },
      { en: "Second", ms: "Kedua", zh: "第二" },
    ]
  );
});

test("rejects incomplete follow-up translation batches", () => {
  assert.throws(
    () =>
      parseTranslationBatch(
        '{"items":[{"index":0,"en":"First","ms":"Pertama","zh":"第一"}]}',
        2
      ),
    /incomplete/i
  );
});


test("provider translation chunks stay within count and source-size bounds", () => {
  const messages = [
    "a".repeat(1000),
    "b".repeat(1000),
    "c".repeat(1000),
    "short one",
    "short two",
    "short three",
    "short four",
  ];

  const chunks = chunkProviderMessages(messages);
  assert.deepEqual(chunks.flat(), messages);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= MAX_PROVIDER_BATCH_MESSAGES);
    assert.ok(
      chunk.reduce((sum, message) => sum + message.length, 0) <=
        MAX_PROVIDER_BATCH_SOURCE_CHARS
    );
  }
  assert.deepEqual(chunks.map((chunk) => chunk.length), [2, 3, 2]);
});

test("a single maximum-length message remains a valid provider chunk", () => {
  const message = "x".repeat(1000);
  assert.deepEqual(chunkProviderMessages([message]), [[message]]);
});
