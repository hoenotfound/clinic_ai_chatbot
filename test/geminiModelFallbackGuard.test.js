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

test("model-capacity sentinel stops key rotation and does not poison key health", async () => {
  resetGeminiKeyPoolState();
  const calls = [];

  await assert.rejects(
    () => runWithGeminiKeys(
      async (apiKey) => {
        calls.push(apiKey);
        const err = new Error("Gemini model is temporarily unavailable.");
        err.code = "GEMINI_MODEL_UNAVAILABLE";
        err.stopGeminiKeyRotation = true;
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

  assert.deepEqual(calls, ["key-a"]);
  assert.deepEqual(getRuntimeCandidateHealth(), []);
  resetGeminiKeyPoolState();
});
