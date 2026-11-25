const { GoogleGenAI } = require("@google/genai");
const { buildSystemPrompt, normalizeOptions } = require("../utils/systemPrompt");
const { buildConversationPromptContext } = require("../utils/conversationPromptContext");
const { generateGeminiContent } = require("./aiUsageService");

// Customer-facing replies default to the current stable Gemini Flash model.
// The higher-level AI service still owns primary/fallback routing and can pass
// an explicit model per attempt without this module caching that choice.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

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

  // Flash-Lite supports minimal thinking; 3.8 Flash does not. Keep the
  // primary model's existing tuning independent of the fallback.
  if (normalized === "gemini-3.5-flash-lite") {
    const requested = String(env.GEMINI_FLASH_LITE_THINKING_LEVEL || "minimal").trim().toLowerCase();
    return { thinkingLevel: ["minimal", "low", "medium", "high"].includes(requested) ? requested : "minimal" };
  }
  if (normalized.startsWith("gemini-3")) {
    const requested = String(env.GEMINI_THINKING_LEVEL || "low").trim().toLowerCase();
    const thinkingLevel = ["low", "medium", "high"].includes(requested)
      ? requested
      : "low";
    return { thinkingLevel };
  }

  // Keep the established 2.5 rollback behavior if an older model is explicitly
  // selected during troubleshooting.
  if (normalized.startsWith("gemini-2.5-flash")) {
    return { thinkingBudget: 0 };
  }

  return null;
}

// Use an explicit shape only for the Flash-Lite reply surfaces. The existing
// parser and all downstream business/clinical checks remain authoritative.
const nullableString = { type: ["string", "null"] };
const conversationReplySchema = {
  type: "object",
  properties: {
    reply: { type: "string" },
    outcome: { type: "string", enum: ["normal", "review_required", "needs_human", "booking_ready"] },
    serviceQuery: { type: "boolean" },
    serviceQuerySource: nullableString,
    priceQuery: { type: "boolean" },
    packageQuery: { type: "boolean" },
    pricingStage: nullableString,
    reviewType: nullableString,
    promotionOption: nullableString,
    treatment: nullableString,
    branch: nullableString,
    appointmentPreference: nullableString,
    appointmentScheduling: { type: "boolean" },
    businessLocationOnly: { type: "boolean" },
    projectLocation: nullableString,
    projectSummary: nullableString,
    nextStep: nullableString,
    staffSummary: nullableString,
  },
  required: ["reply", "outcome", "serviceQuery", "serviceQuerySource", "priceQuery", "packageQuery",
    "pricingStage", "reviewType", "promotionOption", "treatment", "branch", "appointmentPreference", "appointmentScheduling", "businessLocationOnly",
    "projectLocation", "projectSummary", "nextStep", "staffSummary"],
};
const followUpReplySchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["send", "skip", "stop_sequence", "human_review"] },
    message: { type: "string" },
    reason: { type: "string" },
    topic: { type: "string" },
  },
  required: ["action", "message", "reason", "topic"],
};

function buildGeminiRequest(messages, options, resolvedModel, requestControl = {}) {
  const promptOptions = options.surface === "conversation"
    ? {
        ...options,
        conversationContext: buildConversationPromptContext(messages, {
          metaAdContext: options.metaAdContext,
        }),
      }
    : options;
  const isFlashLite = String(resolvedModel || "").trim().toLowerCase() === "gemini-3.5-flash-lite";
  const correctiveRetry = isFlashLite && requestControl.correctiveRetry === true;
  const thinkingConfig = correctiveRetry ? { thinkingLevel: "minimal" } : buildThinkingConfig(resolvedModel);
  const schema = isFlashLite
    ? options.surface === "follow_up" ? followUpReplySchema
      : !options.surface || options.surface === "conversation" ? conversationReplySchema : null
    : null;
  return {
    purpose: options.surface === "follow_up" ? "follow_up_generation" : "customer_reply",
    request: {
      model: resolvedModel,
      contents: buildContents(messages),
      config: {
        systemInstruction: buildSystemPrompt(promptOptions) + (correctiveRetry
          ? "\n\nOUTPUT RECOVERY: Return one complete valid JSON object matching the existing contract. Keep the customer-facing text concise; use null or empty fields only where allowed. Do not omit required fields or weaken any business, safety or handoff rule."
          : ""),
        maxOutputTokens: isFlashLite ? (correctiveRetry ? 3072 : 2048) : 1200,
        responseMimeType: "application/json",
        ...(schema ? { responseJsonSchema: schema } : {}),
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
  model = MODEL,
  requestControl = {}
) {
  const options = normalizeOptions(optionsOrFirstMessage);
  const resolvedKey = apiKey || process.env.GEMINI_API_KEY;
  const resolvedModel = String(model || MODEL).trim() || MODEL;
  if (!resolvedKey) {
    const err = new Error("GEMINI_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const { purpose, request } = buildGeminiRequest(messages, options, resolvedModel, requestControl);
  const ai = new GoogleGenAI({ apiKey: resolvedKey });
  const response = await generateGeminiContent(ai, request, {
    purpose,
    signal: requestControl.signal || null,
    validateResponse: requestControl.validateResponse || null,
    contactId: options.contactId || null,
    leadId: options.leadId || null,
  });

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