const Anthropic = require("@anthropic-ai/sdk");
const { buildSystemPrompt } = require("../utils/systemPrompt");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Use Sonnet for reply quality. Once volume is high, consider routing
// simple FAQ-style messages to Haiku instead to cut cost — same prompt works on both.
const MODEL = "claude-sonnet-5";

/**
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages - full conversation, ending in the latest user message
 * @returns {Promise<string>} the assistant's reply text
 */
async function getReply(messages) {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: buildSystemPrompt(),
    messages,
  });

  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock ? textBlock.text : "Sorry, I couldn't generate a reply — please try again.";
}

module.exports = { getReply };
