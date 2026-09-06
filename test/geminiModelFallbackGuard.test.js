const test = require("node:test");
const assert = require("node:assert/strict");

const { buildThinkingConfig } = require("../src/services/geminiService");
const {
  getRuntimeCandidateHealth,
  resetGeminiKeyPoolState,
  runWithGeminiKeys,
} = require("../src/services/geminiKeyPool");

test("Gemini 3.x uses low thinking while 2.5 Flash keeps thinking disabled", () => {
  assert.deepEqual(
    buildThinkingConfig("gemini-3.7-flash", {}),
    { thinkingLevel: "low" }
  );
  assert.deepEqual(
    buildThinkingConfig("gemini-3.8-flash", { GEMINI_THINKING_LEVEL: "medium" }),
    { thinkingLevel: "medium" }
  );
  assert.deepEqual(
    buildThinkingConfig("gemini-2.5-flash", {}),
    { thinkingBudget: 0 }
  );
});

test("model-capacity sentinel uses exactly one confirmation key and does not poison key health", async () => {
  resetGeminiKeyPoolState();
  const calls = [];

  await assert.rejects(
    () => runWithGeminiKeys(
      async (apiKey) => {
        calls.push(apiKey);
        const cause = new Error("This model is currently experiencing high demand.");
        cause.status = 503;
        const err = new Error("Gemini model is temporarily unavailable.");
        err.code = "GEMINI_MODEL_UNAVAILABLE";
        err.stopGeminiKeyRotation = true;
        err.model = "gemini-3.8-flash";
        err.cause = cause;
        throw err;
      },
      {
        env: { GEMINI_API_KEYS: "key-a,key-b,key-c,key-d,key-e" },
        retryCount: 1,
        smartRetry: true,
        persistHealth: false,
      }
    ),
    (err) => err.code === "GEMINI_MODEL_UNAVAILABLE"
  );

  assert.deepEqual(calls, ["key-a", "key-b"]);
  assert.deepEqual(getRuntimeCandidateHealth(), []);
  resetGeminiKeyPoolState();
});

test("an inconclusive confirmation-key failure never spills into keys 3-5", async () => {
  resetGeminiKeyPoolState();
  const calls = [];

  await assert.rejects(
    () => runWithGeminiKeys(
      async (apiKey) => {
        calls.push(apiKey);
        if (apiKey === "key-a") {
          const cause = new Error("This model is currently experiencing high demand.");
          cause.status = 503;
          const err = new Error("Gemini model is temporarily unavailable.");
          err.code = "GEMINI_MODEL_UNAVAILABLE";
          err.stopGeminiKeyRotation = true;
          err.model = "gemini-3.8-flash";
          err.cause = cause;
          throw err;
        }
        if (apiKey === "key-b") {
          const err = new Error("Rate limit on confirmation project");
          err.status = 429;
          throw err;
        }
        return "should-not-reach-key-c";
      },
      {
        env: { GEMINI_API_KEYS: "key-a,key-b,key-c,key-d,key-e" },
        retryCount: 1,
        smartRetry: true,
        persistHealth: false,
      }
    ),
    (err) => err.status === 429
  );

  assert.deepEqual(calls, ["key-a", "key-b"]);
  const health = getRuntimeCandidateHealth();
  assert.equal(health.length, 1);
  assert.equal(health[0].last_status, "rate_limited");
  resetGeminiKeyPoolState();
});
