const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getGeminiApiKeys,
  isRetryableAiError,
  runCandidate,
} = require("../src/services/aiService");

test("Gemini key configuration is deduplicated in priority order", () => {
  const keys = getGeminiApiKeys({
    GEMINI_API_KEYS: "key-a,key-b\nkey-a",
    GEMINI_API_KEY: "key-main",
    GEMINI_API_KEY_1: "key-b",
    GEMINI_API_KEY_2: "key-c",
  });
  assert.deepEqual(keys, ["key-a", "key-b", "key-main", "key-c"]);
});

test("transient provider errors and invalid model output are retryable", () => {
  assert.equal(isRetryableAiError({ status: 429, message: "quota" }), true);
  assert.equal(isRetryableAiError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableAiError({ code: "INVALID_AI_RESPONSE" }), true);
  assert.equal(isRetryableAiError({ code: "EMPTY_AI_RESPONSE" }), true);
  assert.equal(isRetryableAiError({ status: 400, message: "bad request" }), false);
});

test("candidate retries a transient failure and validates structured success", async () => {
  let attempts = 0;
  const raw = await runCandidate(
    {
      label: "fake AI",
      async run() {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error("temporarily unavailable");
          err.status = 503;
          throw err;
        }
        return JSON.stringify({
          reply: "hello",
          outcome: "normal",
          treatment: null,
          branch: null,
          appointmentPreference: null,
        });
      },
    },
    [{ role: "user", content: "hi" }],
    { isFirstMessage: true, channel: "whatsapp" },
    1000,
    1
  );

  assert.equal(attempts, 2);
  assert.match(raw, /"outcome":"normal"/);
});

test("malformed structured output gets one bounded retry before the candidate fails", async () => {
  let attempts = 0;
  await assert.rejects(
    runCandidate(
      {
        label: "bad AI",
        async run() {
          attempts += 1;
          return '{"reply":"hello"';
        },
      },
      [],
      {},
      1000,
      1
    ),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
  assert.equal(attempts, 2);
});