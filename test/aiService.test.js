const test = require("node:test");
const assert = require("node:assert/strict");

const geminiService = require("../src/services/geminiService");
const { resetGeminiKeyPoolState } = require("../src/services/geminiKeyPool");
const {
  DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS,
  DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS,
  DEFAULT_GEMINI_GLOBAL_BUDGET_MS,
  DEFAULT_GEMINI_MIN_KEY_WINDOW_MS,
  DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS,
  classifyCandidateHealthFailure,
  computeGeminiModelBudgetMs,
  credentialFingerprint,
  getGeminiApiKeys,
  getGeminiReplyModels,
  getGeminiReplyPolicy,
  isGeminiModelUnavailableError,
  isRetryableAiError,
  runCandidate,
  runGeminiReply,
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

test("Gemini reply models default to 3.8 Flash with 3.5 Flash-Lite fallback", () => {
  assert.deepEqual(
    getGeminiReplyModels({}),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
  );
  assert.deepEqual(
    getGeminiReplyModels({ GEMINI_MODEL: "gemini-2.5-flash" }),
    ["gemini-2.5-flash", "gemini-3.8-flash"]
  );
  assert.deepEqual(
    getGeminiReplyModels({ GEMINI_MODEL: "gemini-3.7-flash" }),
    ["gemini-3.7-flash", "gemini-3.8-flash"]
  );
  assert.deepEqual(
    getGeminiReplyModels({
      GEMINI_MODEL: "gemini-3.7-flash",
      GEMINI_FALLBACK_MODEL: "",
    }),
    ["gemini-3.7-flash"]
  );
});

test("Gemini customer replies default to a 25s global adaptive budget", () => {
  const policy = getGeminiReplyPolicy({});
  assert.equal(policy.globalBudgetMs, DEFAULT_GEMINI_GLOBAL_BUDGET_MS);
  assert.equal(policy.globalBudgetMs, 25000);
  assert.equal(policy.preferredTimeoutMs, DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS);
  assert.equal(policy.preferredTimeoutMs, 8000);
  assert.equal(policy.fallbackTimeoutMs, DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS);
  assert.equal(policy.fallbackTimeoutMs, 5000);
  assert.equal(policy.minRemainingKeyWindowMs, DEFAULT_GEMINI_MIN_KEY_WINDOW_MS);
  assert.equal(policy.minRemainingKeyWindowMs, 4000);
  assert.equal(policy.fallbackModelReserveMs, DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS);
  assert.equal(policy.fallbackModelReserveMs, 0);
  assert.equal(policy.retryCount, 1);
});

test("Gemini customer reply timing can be tuned through environment settings", () => {
  const policy = getGeminiReplyPolicy({
    GEMINI_REPLY_GLOBAL_BUDGET_MS: "30000",
    GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "9000",
    GEMINI_REPLY_FALLBACK_TIMEOUT_MS: "6000",
    GEMINI_REPLY_MIN_KEY_WINDOW_MS: "4500",
    GEMINI_REPLY_FALLBACK_MODEL_RESERVE_MS: "9000",
    GEMINI_REPLY_5XX_RETRY_COUNT: "0",
  });
  assert.deepEqual(policy, {
    globalBudgetMs: 30000,
    preferredTimeoutMs: 9000,
    fallbackTimeoutMs: 6000,
    minRemainingKeyWindowMs: 4500,
    fallbackModelReserveMs: 9000,
    retryCount: 0,
  });
});

test("primary Gemini model can reserve time for a fallback model when configured", () => {
  assert.equal(computeGeminiModelBudgetMs(25000, true, 8000), 17000);
  assert.equal(computeGeminiModelBudgetMs(12000, true, 8000), 4000);
  assert.equal(computeGeminiModelBudgetMs(8000, false, 8000), 8000);
  assert.equal(computeGeminiModelBudgetMs(25000, true, 0), 25000);
});

test("Gemini model-capacity errors are distinguished from key failures", () => {
  assert.equal(
    isGeminiModelUnavailableError({
      status: 503,
      message: "This model is currently experiencing high demand.",
    }),
    true
  );
  assert.equal(
    isGeminiModelUnavailableError({
      error: { status: "UNAVAILABLE" },
      message: "Please try again later.",
    }),
    true
  );
  assert.equal(
    isGeminiModelUnavailableError({ status: 429, message: "Quota exceeded" }),
    false
  );
});

test("503 model overload switches to Flash-Lite without trying every Gemini key", async () => {
  resetGeminiKeyPoolState();
  const originalGetReply = geminiService.getReply;
  const calls = [];
  const validReply = JSON.stringify({
    reply: "hello",
    outcome: "normal",
    treatment: null,
    branch: null,
    appointmentPreference: null,
  });

  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    if (model === "gemini-2.5-flash") {
      const err = new Error("This model is currently experiencing high demand.");
      err.status = 503;
      throw err;
    }
    return validReply;
  };

  try {
    const result = await runGeminiReply(
      [{ role: "user", content: "hi" }],
      { channel: "whatsapp", isFirstMessage: false },
      {
        GEMINI_API_KEYS: "key-a,key-b,key-c,key-d,key-e",
        GEMINI_MODEL: "gemini-2.5-flash",
        GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",
        GEMINI_REPLY_5XX_RETRY_COUNT: "0",
      }
    );

    assert.equal(result, validReply);
    assert.deepEqual(calls, [
      { apiKey: "key-a", model: "gemini-2.5-flash" },
      { apiKey: "key-a", model: "gemini-2.5-flash-lite" },
    ]);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
  }
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
    classifyCandidateHealthFailure({ status: 429, message: "quota_exceeded: requests per day" }),
    { status: "rate_limited", failureKind: "quota_exhausted" }
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
