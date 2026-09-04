const test = require("node:test");
const assert = require("node:assert/strict");

const geminiService = require("../src/services/geminiService");
const { resetGeminiKeyPoolState } = require("../src/services/geminiKeyPool");
const {
  getRuntimeGeminiModelHealth,
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

function testEnv() {
  return {
    GEMINI_API_KEYS: "key-a,key-b,key-c,key-d,key-e",
    GEMINI_MODEL: "gemini-2.5-flash",
    GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",
    GEMINI_REPLY_5XX_RETRY_COUNT: "0",
    GEMINI_MODEL_UNAVAILABLE_COOLDOWN_MS: "60000",
  };
}

test("a sustained 503 cools the primary model so later replies skip wasted requests", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const originalGetReply = geminiService.getReply;
  const calls = [];
  let nowMs = 100_000;

  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    if (model === "gemini-2.5-flash") {
      const err = new Error("This model is currently experiencing high demand.");
      err.status = 503;
      throw err;
    }
    return VALID_REPLY;
  };

  const env = testEnv();
  const deps = {
    clock: () => nowMs,
    sleepFn: async () => {},
    randomFn: () => 0,
  };

  try {
    await runGeminiReply([{ role: "user", content: "first" }], {}, env, deps);
    assert.deepEqual(calls.map((item) => item.model), [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);

    calls.length = 0;
    await runGeminiReply([{ role: "user", content: "second" }], {}, env, deps);
    assert.deepEqual(calls.map((item) => item.model), ["gemini-2.5-flash-lite"]);

    const health = getRuntimeGeminiModelHealth(env, nowMs);
    assert.equal(health.find((item) => item.model === "gemini-2.5-flash").status, "cooling_down");

    calls.length = 0;
    nowMs += 60_001;
    await runGeminiReply([{ role: "user", content: "third" }], {}, env, deps);
    assert.deepEqual(calls.map((item) => item.model), [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});

test("when every Gemini model is cooling down no provider requests are spent until retry time", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const originalGetReply = geminiService.getReply;
  const calls = [];
  let nowMs = 200_000;
  const env = testEnv();
  const deps = {
    clock: () => nowMs,
    sleepFn: async () => {},
    randomFn: () => 0,
  };

  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    const err = new Error("This model is currently experiencing high demand.");
    err.status = 503;
    throw err;
  };

  try {
    await assert.rejects(
      runGeminiReply([{ role: "user", content: "first" }], {}, env, deps)
    );
    assert.equal(calls.length, 2);

    calls.length = 0;
    await assert.rejects(
      runGeminiReply([{ role: "user", content: "second" }], {}, env, deps),
      (err) => err.code === "ALL_GEMINI_MODELS_COOLING_DOWN"
    );
    assert.equal(calls.length, 0);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});
