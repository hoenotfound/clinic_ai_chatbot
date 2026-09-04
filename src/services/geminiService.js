const { GoogleGenAI } = require("@google/genai");
const { buildSystemPrompt, normalizeOptions } = require("../utils/systemPrompt");
const { generateGeminiContent } = require("./aiUsageService");

// Keep the long-tested 2.5 Flash default for backward compatibility. The
// higher-level AI service can choose a different primary/fallback model per
// request without this module caching that choice.
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

function buildThinkingConfig(model = MODEL, env = process.env) {
  const normalized = String(model || "").trim().toLowerCase();

  // Gemini 3.x uses thinkingLevel rather than the 2.5 thinkingBudget control.
  // Low is the best fit for a latency-sensitive front-desk chatbot while still
  // retaining the newer models' reasoning capability.
  if (normalized.startsWith("gemini-3")) {
    const requested = String(env.GEMINI_THINKING_LEVEL || "low").trim().toLowerCase();
    const thinkingLevel = ["low", "medium", "high"].includes(requested)
      ? requested
      : "low";
    return { thinkingLevel };
  }

  // The existing production behavior for 2.5 Flash deliberately disables the
  // extra thinking budget so visible customer replies stay fast.
  if (normalized.startsWith("gemini-2.5-flash")) {
    return { thinkingBudget: 0 };
  }

  return null;
}

function buildGeminiRequest(messages, options, resolvedModel) {
  const thinkingConfig = buildThinkingConfig(resolvedModel);
  return {
    purpose: "customer_reply",
    request: {
      model: resolvedModel,
      contents: buildContents(messages),
      config: {
        systemInstruction: buildSystemPrompt(options),
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    },
  };
}

/**
 * Low-level Gemini generation attempt. Setup Status deliberately does not call
 * this module anymore: its connection check uses the non-generative models.get
 * metadata endpoint so running health checks does not consume prompt/output
 * tokens or a generated-response request.
 */
async function getReply(
  messages,
  optionsOrFirstMessage = false,
  apiKey = null,
  model = MODEL
) {
  const options = normalizeOptions(optionsOrFirstMessage);
  const resolvedKey = apiKey || process.env.GEMINI_API_KEY;
  const resolvedModel = String(model || MODEL).trim() || MODEL;
  if (!resolvedKey) {
    const err = new Error("GEMINI_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const { purpose, request } = buildGeminiRequest(messages, options, resolvedModel);
  const ai = new GoogleGenAI({ apiKey: resolvedKey });
  const response = await generateGeminiContent(ai, request, { purpose });

  const text = response.text?.trim();
  if (!text) {
    const err = new Error("Gemini returned an empty response.");
    err.code = "EMPTY_AI_RESPONSE";
    throw err;
  }
  return text;
}

module.exports = {
  MODEL,
  buildContents,
  buildGeminiRequest,
  buildThinkingConfig,
  getReply,
};
