const test = require("node:test");
const assert = require("node:assert/strict");

const aiUsage = require("../src/services/aiUsageService");
const { addAiUsage } = require("../src/routes/setupStatus");

test("setup status exposes real 24h Gemini request, token and failure totals", async () => {
  const originalGetUsageSummary = aiUsage.getUsageSummary;
  aiUsage.getUsageSummary = async () => ({
    windowHours: 24,
    requests: 12,
    successfulRequests: 10,
    failedRequests: 2,
    promptTokens: 42000,
    outputTokens: 3000,
    thinkingTokens: 0,
    cachedTokens: 0,
    totalTokens: 45000,
    averageLatencyMs: 820,
    byModel: [
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        requests: 7,
        successfulRequests: 5,
        failedRequests: 2,
        totalTokens: 22000,
      },
      {
        provider: "gemini",
        model: "gemini-2.5-flash-lite",
        requests: 5,
        successfulRequests: 5,
        failedRequests: 0,
        totalTokens: 23000,
      },
    ],
    byPurpose: [],
    failuresByKind: [
      { failureKind: "model_unavailable", requests: 1 },
      { failureKind: "rate_limit", requests: 1 },
    ],
  });

  try {
    const overview = {
      checks: [
        { key: "ai", summary: "The AI reply engine completed a private test request." },
      ],
    };
    const decorated = await addAiUsage(overview);
    const aiCheck = decorated.checks[0];

    assert.equal(decorated.aiUsage.totalTokens, 45000);
    assert.equal(aiCheck.aiUsage.failedRequests, 2);
    assert.match(aiCheck.summary, /12 requests/i);
    assert.match(aiCheck.summary, /2 failed/i);
    assert.match(aiCheck.summary, /45,000 total tokens/i);
    assert.match(aiCheck.summary, /1 model unavailable\/503/i);
    assert.match(aiCheck.summary, /1 rate limited/i);
    assert.match(aiCheck.summary, /0 quota exhausted/i);
  } finally {
    aiUsage.getUsageSummary = originalGetUsageSummary;
  }
});
