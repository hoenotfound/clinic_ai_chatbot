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

function usageFromInteraction(interaction) {
  const usage = interaction?.usage || {};
  return {
    promptTokens: tokenCount(usage.total_input_tokens ?? usage.totalInputTokens),
    outputTokens: tokenCount(usage.total_output_tokens ?? usage.totalOutputTokens),
    thinkingTokens: tokenCount(usage.total_thought_tokens ?? usage.totalThoughtTokens),
    cachedTokens: tokenCount(usage.total_cached_tokens ?? usage.totalCachedTokens),
    totalTokens: tokenCount(usage.total_tokens ?? usage.totalTokens),
  };
}

function providerErrorCode(error) {
  for (const value of [
    error?.error?.code,
    error?.response?.data?.error?.code,
    error?.response?.body?.error?.code,
    error?.details?.error?.code,
  ]) {
    const code = String(value || "").trim().toLowerCase();
    if (code && !/^\d+$/.test(code)) return code;
  }
  return "";
}

function failureKind(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const providerStatus = String(
    error?.error?.status
      || error?.response?.data?.error?.status
      || error?.response?.body?.error?.status
      || error?.details?.error?.status
      || ""
  ).toUpperCase();
  const providerCode = providerErrorCode(error);
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  if (
    status === 503
    || providerStatus === "UNAVAILABLE"
    || /currently experiencing high demand|model[^.]{0,80}(?:high demand|overload|unavailable)/.test(message)
    || (/\b503\b/.test(message) && /high demand|overload|unavailable|service unavailable/.test(message))
  ) {
    return "model_unavailable";
  }
  if (
    providerCode === "quota_exceeded"
    || /quota_exceeded|requests per day|per-day|per day|daily quota|\brpd\b/.test(message)
  ) {
    return "quota_exhausted";
  }
  if (
    status === 429
    || ["rate_limit_exceeded", "too_many_requests"].includes(providerCode)
    || /rate limit|resource exhausted|too many requests|\b429\b/.test(message)
  ) {
    return "rate_limit";
  }
  if (
    ["authentication", "permission_denied"].includes(providerCode)
    || [401, 403].includes(status)
    || /invalid.*api.?key|unauthorized|permission denied/.test(message)
  ) {
    return "authentication";
  }
  if (
    providerCode === "deadline_exceeded"
    || [408, 504].includes(status)
    || code === "AI_TIMEOUT"
    || /timeout|timed out/.test(message)
  ) {
    return "timeout";
  }
  if (status >= 500 && status <= 599) return "provider_5xx";
  if (code === "INVALID_AI_RESPONSE" || code === "EMPTY_AI_RESPONSE") return "invalid_response";
  return "provider_error";
}

function queueUsage(event, { database = pool, repository = aiUsageRepo } = {}) {
  if (!process.env.DATABASE_URL && database === pool) return;
  Promise.resolve()
    .then(() => repository.recordAiUsage(event, database))
    .catch((err) => {
      console.warn("Could not save AI usage metrics:", err?.message || err);
    });
}

function failedUsageEvent({ model, purpose, latencyMs, error }) {
  return {
    provider: "gemini",
    model,
    purpose,
    status: "failed",
    failureKind: failureKind(error),
    latencyMs,
    promptTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  };
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
      failedUsageEvent({
        model,
        purpose,
        latencyMs: Math.max(0, clock() - startedAt),
        error,
      }),
      { database, repository }
    );
    throw error;
  }
}

async function createGeminiInteraction(
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
    const interaction = await ai.interactions.create(request);
    queueUsage(
      {
        provider: "gemini",
        model,
        purpose,
        status: "success",
        failureKind: null,
        latencyMs: Math.max(0, clock() - startedAt),
        ...usageFromInteraction(interaction),
      },
      { database, repository }
    );
    return interaction;
  } catch (error) {
    queueUsage(
      failedUsageEvent({
        model,
        purpose,
        latencyMs: Math.max(0, clock() - startedAt),
        error,
      }),
      { database, repository }
    );
    throw error;
  }
}

async function getUsageSummary({ database = pool, repository = aiUsageRepo, hours = 24 } = {}) {
  return repository.getAiUsageSummary(database, { hours });
}

module.exports = {
  createGeminiInteraction,
  failureKind,
  generateGeminiContent,
  getUsageSummary,
  providerErrorCode,
  queueUsage,
  tokenCount,
  usageFromInteraction,
  usageFromResponse,
};
