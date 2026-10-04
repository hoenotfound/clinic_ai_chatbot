const Anthropic = require("@anthropic-ai/sdk");

function normalizeWorkspaceId(value) {
  return String(value || "").trim();
}

function buildAnthropicClientOptions({
  apiKey = process.env.ANTHROPIC_API_KEY,
  workspaceId = process.env.ANTHROPIC_WORKSPACE_ID,
  maxRetries = null,
} = {}) {
  const resolvedKey = String(apiKey || "").trim();
  if (!resolvedKey) {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const resolvedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const clientOptions = {
    apiKey: resolvedKey,
    ...(resolvedWorkspaceId
      ? {
          defaultHeaders: {
            "anthropic-workspace-id": resolvedWorkspaceId,
          },
        }
      : {}),
  };

  // Leave this unset for background jobs so the Anthropic SDK keeps its
  // normal transient-retry behavior. Customer replies pass 0 explicitly
  // because aiService owns that retry/time-budget policy itself.
  if (Number.isInteger(maxRetries) && maxRetries >= 0) {
    clientOptions.maxRetries = maxRetries;
  }
  return clientOptions;
}

function createAnthropicClient(options = {}) {
  return new Anthropic(buildAnthropicClientOptions(options));
}

module.exports = {
  buildAnthropicClientOptions,
  createAnthropicClient,
  normalizeWorkspaceId,
};
