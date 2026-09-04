const test = require("node:test");
const assert = require("node:assert/strict");

const setupStatusRepo = require("../src/db/setupStatusRepo");
const aiUsage = require("../src/services/aiUsageService");
const {
  addAiUsage,
  usesGeminiMetadataSetupCheck,
} = require("../src/routes/setupStatus");

test("setup status exposes real 24h Gemini request, token and failure totals", async () => {
  const originalGetUsageSummary = aiUsage.getUsageSummary;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = "claude";
  delete process.env.GEMINI_API_KEY;
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
  } finally {
    aiUsage.getUsageSummary = originalGetUsageSummary;
    if (originalProvider == null) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("Gemini Setup Status explains that every key check is non-generative", async () => {
  const originalGetUsageSummary = aiUsage.getUsageSummary;
  const originalListSetupChecks = setupStatusRepo.listAiCandidateSetupChecks;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-key";
  aiUsage.getUsageSummary = async () => ({
    windowHours: 24,
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    promptTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    averageLatencyMs: 0,
    byModel: [],
    byPurpose: [],
    failuresByKind: [],
  });
  setupStatusRepo.listAiCandidateSetupChecks = async () => [];

  try {
    assert.equal(usesGeminiMetadataSetupCheck(), true);
    const decorated = await addAiUsage({
      checks: [
        { key: "ai", status: "ready", geminiKeyCount: 1, candidateHealth: [], summary: "Old generated-check wording." },
      ],
    });
    const aiCheck = decorated.checks[0];
    assert.equal(aiCheck.setupCheckMode, "model_metadata");
    assert.match(aiCheck.summary, /metadata/i);
    assert.match(aiCheck.summary, /does not generate AI text/i);
    assert.match(aiCheck.summary, /consume prompt\/output tokens/i);
  } finally {
    aiUsage.getUsageSummary = originalGetUsageSummary;
    setupStatusRepo.listAiCandidateSetupChecks = originalListSetupChecks;
    if (originalProvider == null) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});
