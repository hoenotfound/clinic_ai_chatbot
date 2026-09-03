const { GoogleGenAI } = require("@google/genai");
const { buildSystemPrompt, normalizeOptions } = require("../utils/systemPrompt");

// Flash-tier models are what Google's free tier covers as of mid-2026.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function buildContents(messages) {
  return messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";

    if (Array.isArray(m.content)) {
      const parts = m.content.map((part) =>
        part.type === "image"
          ? { inlineData: { mimeType: part.mimeType, data: part.data } }
          : { text: part.text }
      );
      return { role, parts };
    }

    return { role, parts: [{ text: m.content }] };
  });
}

/**
 * Low-level Gemini attempt. apiService.js supplies the API key so it can rotate
 * keys and fail over without this provider caching one key at module startup.
 */
async function getReply(messages, optionsOrFirstMessage = false, apiKey = null) {
  const options = normalizeOptions(optionsOrFirstMessage);
  const resolvedKey = apiKey || process.env.GEMINI_API_KEY;
  if (!resolvedKey) {
    const err = new Error("GEMINI_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const ai = new GoogleGenAI({ apiKey: resolvedKey });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildContents(messages),
    config: {
      systemInstruction: buildSystemPrompt(options),
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
      // Flash 2.5 has thinking on by default; these front-desk responses don't
      // need a large reasoning budget and visible output matters more.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const text = response.text?.trim();
  if (!text) {
    const err = new Error("Gemini returned an empty response.");
    err.code = "EMPTY_AI_RESPONSE";
    throw err;
  }
  return text;
}

module.exports = { MODEL, buildContents, getReply };
