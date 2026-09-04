const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getEffectiveGeminiMinKeyWindowMs,
  getGeminiReplyPolicy,
} = require("../src/services/aiService");
const { computeAttemptTimeoutMs } = require("../src/services/geminiKeyPool");

test("large Gemini key pools scale the reserved window instead of starving early keys", () => {
  const env = {
    GEMINI_API_KEYS: Array.from({ length: 10 }, (_, index) => `key-${index + 1}`).join(","),
  };
  const policy = getGeminiReplyPolicy(env);
  const effectiveWindow = getEffectiveGeminiMinKeyWindowMs(env, policy);

  assert.equal(policy.globalBudgetMs, 25000);
  assert.equal(policy.minRemainingKeyWindowMs, 4000);
  assert.equal(effectiveWindow, 2500);

  const firstAttemptTimeout = computeAttemptTimeoutMs({
    remainingBudgetMs: policy.globalBudgetMs,
    candidatePosition: 0,
    totalCandidates: 10,
    preferredTimeoutMs: policy.preferredTimeoutMs,
    fallbackTimeoutMs: policy.fallbackTimeoutMs,
    minRemainingKeyWindowMs: effectiveWindow,
  });

  assert.equal(firstAttemptTimeout, 2500);
  assert.ok(firstAttemptTimeout > 1000);
});

test("normal five-key pools keep the intended four-second reserve", () => {
  const env = { GEMINI_API_KEYS: "key-1,key-2,key-3,key-4,key-5" };
  const policy = getGeminiReplyPolicy(env);

  assert.equal(getEffectiveGeminiMinKeyWindowMs(env, policy), 4000);
});
