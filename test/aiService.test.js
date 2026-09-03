const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyCandidateHealthFailure,
  credentialFingerprint,
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

test("AI candidate health classifies quota, credential and temporary failures", () => {
  assert.deepEqual(
    classifyCandidateHealthFailure({ status: 429, message: "Resource exhausted" }),
    { status: "rate_limited", failureKind: "rate_limit" }
  );
  assert.deepEqual(
    classifyCandidateHealthFailure({ status: 401, message: "Unauthorized" }),
    { status: "invalid", failureKind: "authentication" }
  );
  assert.deepEqual(
    classifyCandidateHealthFailure({ status: 503, message: "Unavailable" }),
    { status: "unavailable", failureKind: "temporary_failure" }
  );
  assert.equal(credentialFingerprint("private-key").length, 24);
  assert.equal(credentialFingerprint("private-key").includes("private-key"), false);
});

test("candidate retries a transient failure and validates structured success", async () => {
  let attempts = 0;
  const health = [];
  const raw = await runCandidate(
    {
      label: "fake AI",
      reportOutcome(outcome) { health.push(outcome); },
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
  assert.deepEqual(health, [
    { status: "unavailable", failureKind: "temporary_failure" },
    { status: "ready", failureKind: null },
  ]);
  assert.match(raw, /"outcome":"normal"/);
});

test("a quota failure is recorded before rotating away from a candidate", async () => {
  const health = [];
  await assert.rejects(
    runCandidate(
      {
        label: "limited AI",
        reportOutcome(outcome) { health.push(outcome); },
        async run() {
          const err = new Error("Quota exceeded");
          err.status = 429;
          throw err;
        },
      },
      [],
      {},
      1000,
      0
    )
  );
  assert.deepEqual(health, [
    { status: "rate_limited", failureKind: "rate_limit" },
  ]);
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
