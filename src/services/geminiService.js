const { GoogleGenAI } = require("@google/genai");
const { buildSystemPrompt } = require("../utils/systemPrompt");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Flash-tier models are what Google's free tier covers as of mid-2026.
// Model names on the free tier shift fairly often — if this model returns
// a 404/"not found" error, open Google AI Studio, check which model shows
// a free quota right now, and update GEMINI_MODEL in your .env.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages - full conversation, ending in the latest user message
 * @returns {Promise<string>} the assistant's reply text
 */
async function getReply(messages) {
  // Gemini uses "model" instead of "assistant" as the role name, and expects
  // parts arrays rather than plain strings.
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: buildSystemPrompt(),
      maxOutputTokens: 500,
    },
  });

  const text = response.text;
  return text || "Sorry, I couldn't generate a reply — please try again.";
}

module.exports = { getReply };
