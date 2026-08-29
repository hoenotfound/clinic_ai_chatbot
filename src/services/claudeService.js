const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt } = require("../utils/systemPrompt");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Use Sonnet for reply quality. Once volume is high, consider routing
// simple FAQ-style messages to Haiku instead to cut cost — same prompt works on both.
const MODEL = "claude-3-5-sonnet-latest";

/**
 * @param {Array<{role: 'user'|'assistant', content: string|Array<object>}>} messages - full conversation, ending in the latest user message
 * @param {boolean} isFirstMessage - true if this is the patient's first-ever message (see server.js)
 * @returns {Promise<string>} the assistant's reply text
 */
async function getReply(messages, isFirstMessage = false) {
  // Most messages have plain string content (from history); a message with a
  // live photo attached (see aiService.js) instead has content as an array
  // of generic {type, ...} parts that need converting to Claude's block format.
  const claudeMessages = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;

    const content = m.content.map((part) =>
      part.type === "image"
        ? { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }
        : { type: "text", text: part.text }
    );
    return { role: m.role, content };
  });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: buildSystemPrompt(isFirstMessage),
    messages: claudeMessages,
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock ? textBlock.text : "Sorry, I couldn't generate a reply — please try again.";
}

module.exports = { getReply };
