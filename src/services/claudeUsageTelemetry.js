const { failureKind, queueUsage } = require("./aiUsageService");

// Anthropic counts cache reads/writes separately from uncached input tokens.
// Store their sum as prompt tokens so the existing Usage screen remains useful,
// and retain cache creation separately for correct Sonnet cost estimates.
function claudeUsageEvent(response, {
  purpose = "customer_reply",
  model = "claude-sonnet-5",
  contactId = null,
  leadId = null,
  latencyMs = null,
} = {}) {
  const usage = response?.usage || {};
  const count = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value) : 0;
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const write = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  return {
    provider: "claude",
    model: String(response?.model || model).slice(0, 120),
    purpose,
    status: "success",
    ...(latencyMs != null ? { latencyMs } : {}),
    responseDisposition: "provider_completed",
    promptTokens: input + read + write,
    outputTokens: output,
    cachedTokens: read,
    cacheWriteTokens: write,
    thinkingTokens: 0,
    totalTokens: input + read + write + output,
    ...(contactId != null ? { contactId } : {}),
    ...(leadId != null ? { leadId } : {}),
  };
}

function recordClaudeUsage(response, options = {}) {
  queueUsage(claudeUsageEvent(response, options));
}

function claudeFailureUsageEvent(error, {
  purpose = "customer_reply",
  model = "claude-sonnet-5",
  contactId = null,
  leadId = null,
  latencyMs = null,
} = {}) {
  const code = String(error?.code || error?.name || "").toLowerCase();
  const aborted = /abort|timeout/.test(code) || error?.cause?.name === "AbortError";
  return {
    provider: "claude",
    model,
    purpose,
    status: "failed",
    failureKind: failureKind(error),
    responseDisposition: aborted ? "aborted_without_usage" : "provider_error",
    promptTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    ...(latencyMs != null ? { latencyMs } : {}),
    ...(contactId != null ? { contactId } : {}),
    ...(leadId != null ? { leadId } : {}),
  };
}

function recordClaudeFailure(error, options = {}) {
  // A rejected network/API request may still be billable. No usage data is
  // available: mark cost unknown instead of reporting a zero-dollar attempt.
  queueUsage(claudeFailureUsageEvent(error, options));
}

async function trackClaudeRequest(operation, options = {}) {
  const startedAt = Date.now();
  try {
    const response = await operation();
    recordClaudeUsage(response, { ...options, latencyMs: Date.now() - startedAt });
    return response;
  } catch (error) {
    recordClaudeFailure(error, { ...options, latencyMs: Date.now() - startedAt });
    throw error;
  }
}

module.exports = {
  claudeUsageEvent,
  claudeFailureUsageEvent,
  recordClaudeUsage,
  recordClaudeFailure,
  trackClaudeRequest,
};
