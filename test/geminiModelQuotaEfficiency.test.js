const test = require("node:test");
const assert = require("node:assert/strict");

const geminiService = require("../src/services/geminiService");
const { resetGeminiKeyPoolState } = require("../src/services/geminiKeyPool");
const {
  resetGeminiModelHealth,
  runGeminiReply,
} = require("../src/services/aiService");

const VALID_REPLY = JSON.stringify({
  reply: "hello",
  outcome: "normal",
  treatment: null,
  branch: null,
  appointmentPreference: null,
});

test("503 switches to the available fallback model immediately even when 5xx retry is enabled", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const originalGetReply = geminiService.getReply;
  const calls = [];

  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    if (model === "gemini-2.5-flash") {
      const err = new Error("This model is currently experiencing high demand.");
      err.status = 503;
      throw err;
    }
    return VALID_REPLY;
  };

  try {
    const result = await runGeminiReply(
      [{ role: "user", content: "hi" }],
      { channel: "whatsapp", isFirstMessage: false },
      {
        GEMINI_API_KEYS: "key-a,key-b,key-c,key-d,key-e",
        GEMINI_MODEL: "gemini-2.5-flash",
        GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",
        GEMINI_REPLY_5XX_RETRY_COUNT: "1",
        GEMINI_MODEL_UNAVAILABLE_COOLDOWN_MS: "60000",
      },
      { sleepFn: async () => {} }
    );

    assert.equal(result, VALID_REPLY);
    assert.deepEqual(calls, [
      { apiKey: "key-a", model: "gemini-2.5-flash" },
      { apiKey: "key-a", model: "gemini-2.5-flash-lite" },
    ]);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});

test("a single configured Gemini model still gets its bounded 503 retry", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const originalGetReply = geminiService.getReply;
  let attempts = 0;

  geminiService.getReply = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("This model is currently experiencing high demand.");
      err.status = 503;
      throw err;
    }
    return VALID_REPLY;
  };

  try {
    const result = await runGeminiReply(
      [{ role: "user", content: "hi" }],
      { channel: "whatsapp", isFirstMessage: false },
      {
        GEMINI_API_KEY: "key-a",
        GEMINI_MODEL: "gemini-2.5-flash",
        GEMINI_FALLBACK_MODEL: "",
        GEMINI_REPLY_5XX_RETRY_COUNT: "1",
      },
      { sleepFn: async () => {}, randomFn: () => 0 }
    );

    assert.equal(result, VALID_REPLY);
    assert.equal(attempts, 2);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});
