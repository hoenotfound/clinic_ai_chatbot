const test = require("node:test");
const assert = require("node:assert/strict");
const { estimateAiUsage, getRate } = require("../src/services/aiCostEstimator");

test("Gemini standard rate accounts for cached input and thinking output", () => {
  const result = estimateAiUsage({
    provider: "gemini", model: "gemini-3.8-flash", status: "success",
    promptTokens: 10000, cachedTokens: 4000, outputTokens: 200, thinkingTokens: 100,
  }, new Date("2026-10-09T00:00:00Z"));
  assert.deepEqual(result, { costUsd: 0.005925, pricingStatus: "estimated" });
});

test("Gemini rate changes after December 2026; legacy cost estimates stay at event-time rate", () => {
  assert.equal(getRate("gemini", "gemini-3.8-flash", new Date("2026-12-31T23:59:00Z")).input, 0.75);
  assert.equal(getRate("gemini", "gemini-3.8-flash", new Date("2027-01-01T00:00:00Z")).input, 1.50);
  assert.equal(getRate("gemini", "gemini-3.5-flash", new Date("2027-01-01T00:00:00Z")).input, 1.50);
});

test("Claude Sonnet estimates distinguish cache writes, reads and normal inputs", () => {
  const result = estimateAiUsage({
    provider: "claude", model: "claude-sonnet-5",
    promptTokens: 1300, cachedTokens: 200, cacheWriteTokens: 100,
    outputTokens: 50,
  });
  assert.deepEqual(result, { costUsd: 0.00279, pricingStatus: "estimated" });
});

test("unknown provider, model, and missing usage never look free", () => {
  assert.deepEqual(estimateAiUsage({
    provider: "gemini", model: "gemini-3.8-flash",
    status: "failed", promptTokens: 0, outputTokens: 0,
  }), { costUsd: null, pricingStatus: "usage_unknown" });
  assert.deepEqual(estimateAiUsage({
    provider: "gemini", model: "not-configured", promptTokens: 1000,
  }), { costUsd: null, pricingStatus: "unpriced_model" });
  assert.deepEqual(estimateAiUsage({
    provider: "claude", model: "unsupported", promptTokens: 200,
  }), { costUsd: null, pricingStatus: "unpriced_model" });
});

test("cached counts cannot exceed prompt tokens in cost estimate", () => {
  const result = estimateAiUsage({ provider: "gemini", model: "gemini-3.5-flash-lite",
    promptTokens: 100, cachedTokens: 200, outputTokens: 0 });
  assert.equal(result.costUsd, 0.000003);
});
