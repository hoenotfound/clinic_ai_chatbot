const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt, normalizeOptions } = require("../utils/systemPrompt");

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

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

async function getReply(messages, optionsOrFirstMessage = false, apiKey = null) {
  const options = normalizeOptions(optionsOrFirstMessage);
  const resolvedKey = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!resolvedKey) {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const anthropic = new Anthropic({ apiKey: resolvedKey });
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1000,
    system: buildSystemPrompt(options),
    messages: buildClaudeMessages(messages),
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock?.text?.trim();
  if (!text) {
    const err = new Error("Claude returned an empty response.");
    err.code = "EMPTY_AI_RESPONSE";
    throw err;
  }
  return text;
}

module.exports = { MODEL, buildClaudeMessages, getReply };
