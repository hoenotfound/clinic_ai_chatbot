const { pool } = require("../db/db");
const aiUsageRepo = require("../db/aiUsageRepo");

function tokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function usageFromResponse(response) {
  const usage = response?.usageMetadata || {};
  return {
    promptTokens: tokenCount(usage.promptTokenCount),
    outputTokens: tokenCount(usage.candidatesTokenCount),
    thinkingTokens: tokenCount(usage.thoughtsTokenCount),
    cachedTokens: tokenCount(usage.cachedContentTokenCount),
    totalTokens: tokenCount(usage.totalTokenCount),
  };
}

function failureKind(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const providerStatus = String(
    error?.error?.status
      || error?.response?.data?.error?.status
      || error?.response?.body?.error?.status
      || ""
  ).toUpperCase();
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  if (status === 503 || providerStatus === "UNAVAILABLE") return "model_unavailable";
  if (status === 429 || /quota|rate limit|resource exhausted/.test(message)) return "rate_limit";
  if ([401, 403].includes(status) || /invalid.*api.?key|unauthorized|permission denied/.test(message)) {
    return "authentication";
  }
  if ([408, 504].includes(status) || code === "AI_TIMEOUT" || /timeout|timed out/.test(message)) {
    return "timeout";
  }
  if (status >= 500 && status <= 599) return "provider_5xx";
  if (code === "INVALID_AI_RESPONSE" || code === "EMPTY_AI_RESPONSE") return "invalid_response";
  return "provider_error";
}

function queueUsage(event, { database = pool, repository = aiUsageRepo } = {}) {
  if (!process.env.DATABASE_URL && database === pool) return;
  Promise.resolve(repository.recordAiUsage(event, database)).catch((err) => {
    console.warn("Could not save AI usage metrics:", err?.message || err);
  });
}

async function generateGeminiContent(
  ai,
  request,
  {
    purpose = "customer_reply",
    database = pool,
    repository = aiUsageRepo,
    clock = () => Date.now(),
  } = {}
) {
  const model = String(request?.model || "unknown");
  const startedAt = clock();
  try {
    const response = await ai.models.generateContent(request);
    queueUsage(
      {
        provider: "gemini",
        model,
        purpose,
        status: "success",
        failureKind: null,
        latencyMs: Math.max(0, clock() - startedAt),
        ...usageFromResponse(response),
      },
      { database, repository }
    );
    return response;
  } catch (error) {
    queueUsage(
      {
        provider: "gemini",
        model,
        purpose,
        status: "failed",
        failureKind: failureKind(error),
        latencyMs: Math.max(0, clock() - startedAt),
        promptTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      },
      { database, repository }
    );
    throw error;
  }
}

async function getUsageSummary({ database = pool, repository = aiUsageRepo, hours = 24 } = {}) {
  return repository.getAiUsageSummary(database, { hours });
}

module.exports = {
  failureKind,
  generateGeminiContent,
  getUsageSummary,
  queueUsage,
  tokenCount,
  usageFromResponse,
};
