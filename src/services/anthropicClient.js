const Anthropic = require("@anthropic-ai/sdk");

function normalizeWorkspaceId(value) {
  return String(value || "").trim();
}

function buildAnthropicClientOptions({
  apiKey = process.env.ANTHROPIC_API_KEY,
  workspaceId = process.env.ANTHROPIC_WORKSPACE_ID,
} = {}) {
  const resolvedKey = String(apiKey || "").trim();
  if (!resolvedKey) {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const resolvedWorkspaceId = normalizeWorkspaceId(workspaceId);
  return {
    apiKey: resolvedKey,
    // aiService already owns retry and timeout policy. Disable the SDK's
    // hidden retries so one Claude attempt cannot silently exceed that budget.
    maxRetries: 0,
    ...(resolvedWorkspaceId
      ? {
          defaultHeaders: {
            "anthropic-workspace-id": resolvedWorkspaceId,
          },
        }
      : {}),
  };
}

function createAnthropicClient(options = {}) {
  return new Anthropic(buildAnthropicClientOptions(options));
}

module.exports = {
  buildAnthropicClientOptions,
  createAnthropicClient,
  normalizeWorkspaceId,
};
