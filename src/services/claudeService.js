const { normalizeWorkspaceId } = require("./anthropicClient");
const { buildSystemPrompt, normalizeOptions } = require("../utils/systemPrompt");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_REPLY_MAX_TOKENS = 4096;
const TRUNCATION_RETRY_MAX_TOKENS = 8192;
const DEFAULT_REPLY_EFFORT = "medium";

function buildClaudeMessages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;

    const content = m.content.map((part) =>
      part.type === "image"
        ? { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }
        : { type: "text", text: part.text }
    );
    return { role: m.role, content };
  });
}

function nullableString() {
  return { type: ["string", "null"] };
}

function buildConversationOutputSchema() {
  return {
    type: "object",
    properties: {
      reply: { type: "string" },
      outcome: {
        type: "string",
        enum: ["normal", "needs_human", "booking_ready"],
      },
      priceQuery: { type: "boolean" },
      packageQuery: { type: "boolean" },
      promotionOption: nullableString(),
      treatment: nullableString(),
      branch: nullableString(),
      appointmentPreference: nullableString(),
      projectLocation: nullableString(),
      projectSummary: nullableString(),
      nextStep: {
        enum: ["site_visit", "quotation_discussion", null],
      },
      staffSummary: nullableString(),
    },
    required: [
      "reply",
      "outcome",
      "priceQuery",
      "packageQuery",
      "promotionOption",
      "treatment",
      "branch",
      "appointmentPreference",
      "projectLocation",
      "projectSummary",
      "nextStep",
      "staffSummary",
    ],
    additionalProperties: false,
  };
}

function buildCommentOutputSchema() {
  return {
    type: "object",
    properties: {
      reply: { type: "string" },
      outcome: {
        type: "string",
        enum: ["normal", "needs_human"],
      },
      treatment: nullableString(),
      branch: nullableString(),
      appointmentPreference: nullableString(),
      projectLocation: nullableString(),
      projectSummary: nullableString(),
      nextStep: { type: "null" },
      publicReply: { type: "string" },
      privateReply: { type: "string" },
      shouldRespond: { type: "boolean" },
    },
    required: [
      "reply",
      "outcome",
      "treatment",
      "branch",
      "appointmentPreference",
      "projectLocation",
      "projectSummary",
      "nextStep",
      "publicReply",
      "privateReply",
      "shouldRespond",
    ],
    additionalProperties: false,
  };
}

function buildClaudeOutputSchema(options = {}) {
  return options.surface === "comment_automation"
    ? buildCommentOutputSchema()
    : buildConversationOutputSchema();
}

function createClaudeHttpError(status, bodyText, parsedBody = null) {
  const providerMessage = String(
    parsedBody?.error?.message
      || parsedBody?.message
      || bodyText
      || `Claude API request failed with HTTP ${status}.`
  ).trim();

  const err = new Error(providerMessage.slice(0, 1200));
  err.status = status;
  err.statusCode = status;
  err.provider = "claude";
  if (status === 401 || status === 403) {
    err.code = "AI_PROVIDER_AUTHENTICATION_FAILED";
  }
  return err;
}

async function createClaudeMessage({
  apiKey,
  workspaceId,
  body,
  signal = null,
  fetchImpl = global.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Claude HTTP client is unavailable because fetch is not configured.");
  }

  const resolvedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      ...(resolvedWorkspaceId
        ? { "anthropic-workspace-id": resolvedWorkspaceId }
        : {}),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  const bodyText = await response.text();
  let parsed = null;
  if (bodyText) {
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    throw createClaudeHttpError(response.status, bodyText, parsed);
  }
  if (!parsed || typeof parsed !== "object") {
    const err = new Error("Claude returned an invalid API response.");
    err.code = "INVALID_AI_RESPONSE";
    throw err;
  }
  return parsed;
}

async function getReply(
  messages,
  optionsOrFirstMessage = false,
  apiKey = null,
  workspaceId = null,
  requestControl = {}
) {
  const options = normalizeOptions(optionsOrFirstMessage);
  const resolvedKey = String(apiKey || process.env.ANTHROPIC_API_KEY || "").trim();
  if (!resolvedKey) {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const maxTokens = requestControl?.previousFailureCode === "AI_OUTPUT_TRUNCATED"
    ? TRUNCATION_RETRY_MAX_TOKENS
    : DEFAULT_REPLY_MAX_TOKENS;

  const response = await createClaudeMessage({
    apiKey: resolvedKey,
    workspaceId: workspaceId || process.env.ANTHROPIC_WORKSPACE_ID,
    signal: requestControl?.signal || null,
    fetchImpl: requestControl?.fetchImpl || global.fetch,
    body: {
      model: MODEL,
      max_tokens: maxTokens,
      system: buildSystemPrompt(options),
      messages: buildClaudeMessages(messages),
      output_config: {
        effort: DEFAULT_REPLY_EFFORT,
        format: {
          type: "json_schema",
          schema: buildClaudeOutputSchema(options),
        },
      },
    },
  });

  if (response.stop_reason === "refusal") {
    const err = new Error("Claude refused the request.");
    err.code = "AI_PROVIDER_REFUSAL";
    throw err;
  }
  if (response.stop_reason === "max_tokens") {
    const err = new Error(
      `Claude hit the output token limit before completing the structured reply (max_tokens=${maxTokens}).`
    );
    err.code = "AI_OUTPUT_TRUNCATED";
    err.maxTokens = maxTokens;
    throw err;
  }

  const textBlock = Array.isArray(response.content)
    ? response.content.find((block) => block?.type === "text")
    : null;
  const text = textBlock?.text?.trim();
  if (!text) {
    const err = new Error("Claude returned an empty response.");
    err.code = "EMPTY_AI_RESPONSE";
    throw err;
  }
  return text;
}

module.exports = {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  DEFAULT_REPLY_EFFORT,
  DEFAULT_REPLY_MAX_TOKENS,
  TRUNCATION_RETRY_MAX_TOKENS,
  MODEL,
  buildClaudeMessages,
  buildClaudeOutputSchema,
  createClaudeHttpError,
  createClaudeMessage,
  getReply,
};
