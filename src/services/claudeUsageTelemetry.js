const { queueUsage } = require("./aiUsageService");

// Anthropic counts cache reads/writes separately from uncached input tokens.
// Store their sum as prompt tokens so the existing Usage screen remains useful,
// and retain cache creation separately for correct Sonnet cost estimates.
function claudeUsageEvent(response, {
  purpose = "customer_reply",
  model = "claude-sonnet-5",
  contactId = null,
  leadId = null,
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

module.exports = { claudeUsageEvent, recordClaudeUsage };
