const { createHash } = require("node:crypto");
const { pool } = require("../db/db");
const aiUsageRepo = require("../db/aiUsageRepo");

function tokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

// Do not conflate the SDK omitting a cache-count field with Gemini reporting
// an actual zero. 0 means "reported, but no cached tokens"; null means unknown.
function hasReportedCacheCount(usage, ...names) {
  return names.some((name) =>
    Object.prototype.hasOwnProperty.call(usage, name) &&
    usage[name] !== null &&
    usage[name] !== undefined &&
    Number.isFinite(Number(usage[name])) &&
    Number(usage[name]) >= 0
  );
}

function promptPrefixFingerprint(request) {
  const systemInstruction = request?.config?.systemInstruction;
  if (typeof systemInstruction !== "string" || !systemInstruction) return null;
  // Only an opaque digest of a fixed-length prefix is persisted. Never log
  // customer messages, provider keys or clinic instructions.
  return createHash("sha256")
    .update(systemInstruction.slice(0, 8192), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function usageFromResponse(response) {
  const usage = response?.usageMetadata || {};
  return {
    promptTokens: tokenCount(usage.promptTokenCount),
    outputTokens: tokenCount(usage.candidatesTokenCount),
    thinkingTokens: tokenCount(usage.thoughtsTokenCount),
    cachedTokens: tokenCount(usage.cachedContentTokenCount),
    cacheMetadataPresent: hasReportedCacheCount(usage, "cachedContentTokenCount"),
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
    cacheMetadataPresent: hasReportedCacheCount(usage, "total_cached_tokens", "totalCachedTokens"),
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
    || /quota[_ ]exceeded|requests\s*per\s*day|requestsperday|generate.?requests.?per.?day.?per.?project.?per.?model|daily quota|\brpd\b/.test(message)
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
    signal = null,
    validateResponse = null,
  } = {}
) {
  const model = String(request?.model || "unknown");
  const startedAt = clock();
  const prefixHash = promptPrefixFingerprint(request);
  // The abort signal belongs to the SDK client, not the wire-format prompt.
  // The provider can still charge for requests already received by its servers.
  const effectiveRequest = signal
    ? { ...request, config: { ...(request?.config || {}), abortSignal: signal } }
    : request;
  let response;
  try {
    response = await ai.models.generateContent(effectiveRequest);
  } catch (error) {
    const timedOut = signal?.aborted === true;
    const failure = timedOut
      ? Object.assign(new Error("Gemini attempt was aborted after a client timeout; provider billing is unknown."), {
          code: "AI_TIMEOUT", cause: error,
        })
      : error;
    queueUsage(
      {
        ...failedUsageEvent({
          model, purpose, latencyMs: Math.max(0, clock() - startedAt),
          error: failure,
        }),
        responseDisposition: timedOut ? "aborted_without_usage" : "provider_error",
      },
      { database, repository }
    );
    throw failure;
  }

  let rejected = null;
  let disposition = signal?.aborted ? "discarded_timeout" : "provider_completed";
  if (!signal?.aborted && typeof validateResponse === "function") {
    try {
      await validateResponse(response);
      disposition = "accepted";
    } catch (error) {
      rejected = error;
      disposition = "rejected_invalid_output";
    }
  }
  // A completed provider call is still potentially billable even if its reply
  // was rejected or became unusable after the caller's deadline.
  queueUsage(
    {
      provider: "gemini",
      model,
      purpose,
      status: "success",
      failureKind: null,
      responseDisposition: disposition,
      latencyMs: Math.max(0, clock() - startedAt),
      ...usageFromResponse(response),
      ...(prefixHash ? { promptPrefixHash: prefixHash } : {}),
    },
    { database, repository }
  );
  if (signal?.aborted) {
    const err = new Error("Gemini response arrived after the attempt was cancelled; it was discarded.");
    err.code = "AI_TIMEOUT";
    throw err;
  }
  if (rejected) throw rejected;
  return response;
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
        ...(promptPrefixFingerprint(request) ? { promptPrefixHash: promptPrefixFingerprint(request) } : {}),
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
  promptPrefixFingerprint,
  queueUsage,
  tokenCount,
  usageFromInteraction,
  usageFromResponse,
};
