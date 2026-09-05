const test = require("node:test");
const assert = require("node:assert/strict");

const geminiService = require("../src/services/geminiService");
const {
  DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS,
  DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS,
  DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS,
  resetGeminiModelHealth,
  runGeminiReply,
} = require("../src/services/aiService");
const {
  getRuntimeCandidateHealth,
  resetGeminiKeyPoolState,
} = require("../src/services/geminiKeyPool");

const VALID_REPLY = JSON.stringify({
  reply: "hello",
  outcome: "normal",
  treatment: null,
  branch: null,
  appointmentPreference: null,
});

test("reply timing defaults give the primary more time while reserving fallback capacity", () => {
  assert.equal(DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS, 10_000);
  assert.equal(DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS, 8_000);
  assert.equal(DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS, 9_000);
});

test("a slow primary model switches to fallback on the same healthy key", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const originalGetReply = geminiService.getReply;
  const calls = [];

  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    if (model === "gemini-3.8-flash") {
      return new Promise(() => {});
    }
    return VALID_REPLY;
  };

  try {
    const result = await runGeminiReply(
      [{ role: "user", content: "hi" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      {
        GEMINI_API_KEYS: "key-a,key-b,key-c,key-d,key-e",
        GEMINI_REPLY_GLOBAL_BUDGET_MS: "100",
        GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "10",
        GEMINI_REPLY_FALLBACK_TIMEOUT_MS: "20",
        GEMINI_REPLY_MIN_KEY_WINDOW_MS: "20",
        GEMINI_REPLY_FALLBACK_MODEL_RESERVE_MS: "40",
        GEMINI_REPLY_5XX_RETRY_COUNT: "0",
      }
    );

    assert.equal(result, VALID_REPLY);
    assert.deepEqual(calls, [
      { apiKey: "key-a", model: "gemini-3.8-flash" },
      { apiKey: "key-a", model: "gemini-3.5-flash-lite" },
    ]);

    const health = getRuntimeCandidateHealth();
    assert.equal(health.length, 1);
    assert.equal(health[0].last_status, "ready");
    assert.equal(health[0].last_failure_at, null);
    assert.equal(health[0].cooldown_until, null);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});
