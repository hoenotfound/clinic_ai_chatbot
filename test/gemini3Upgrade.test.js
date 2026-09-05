const test = require("node:test");
const assert = require("node:assert/strict");

const geminiService = require("../src/services/geminiService");
const {
  DEFAULT_GEMINI_ALTERNATE_MODEL,
  DEFAULT_GEMINI_MODEL,
  getGeminiReplyModels,
  resetGeminiModelHealth,
  runGeminiReply,
} = require("../src/services/aiService");
const { resetGeminiKeyPoolState } = require("../src/services/geminiKeyPool");

test("Gemini 3 production defaults are pinned and require no model env variables", () => {
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.8-flash");
  assert.equal(DEFAULT_GEMINI_ALTERNATE_MODEL, "gemini-3.5-flash-lite");
  assert.deepEqual(
    getGeminiReplyModels({}),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
  );
});

test("both Gemini 3 reply models use low thinking by default", () => {
  assert.deepEqual(
    geminiService.buildThinkingConfig("gemini-3.8-flash", {}),
    { thinkingLevel: "low" }
  );
  assert.deepEqual(
    geminiService.buildThinkingConfig("gemini-3.5-flash-lite", {}),
    { thinkingLevel: "low" }
  );
  assert.deepEqual(
    geminiService.buildThinkingConfig("gemini-3.8-flash", {
      GEMINI_THINKING_LEVEL: "minimal",
    }),
    { thinkingLevel: "low" }
  );
});

test("Gemini 3 request keeps mixed Malaysian language content and structured output settings", () => {
  const mixedLanguageMessage = "Hi, nak tanya HIFU 多少钱？ weekend got slot?";
  const { purpose, request } = geminiService.buildGeminiRequest(
    [{ role: "user", content: mixedLanguageMessage }],
    { isFirstMessage: true, channel: "whatsapp" },
    "gemini-3.8-flash"
  );

  assert.equal(purpose, "customer_reply");
  assert.equal(request.model, "gemini-3.8-flash");
  assert.equal(request.contents[0].parts[0].text, mixedLanguageMessage);
  assert.equal(request.config.responseMimeType, "application/json");
  assert.equal(request.config.maxOutputTokens, 1200);
  assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: "low" });
  assert.equal(Object.hasOwn(request.config, "temperature"), false);
  assert.equal(Object.hasOwn(request.config, "topP"), false);
  assert.equal(Object.hasOwn(request.config, "topK"), false);
});

test("default 3.8 capacity failure falls back to 3.5 Flash-Lite on the same Gemini key", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const originalGetReply = geminiService.getReply;
  const calls = [];
  const validReply = JSON.stringify({
    reply: "Boleh 😊 Weekend ada slot. Nak saya bantu semak cawangan yang sesuai?",
    outcome: "normal",
    treatment: "HIFU",
    branch: null,
    appointmentPreference: "weekend",
  });

  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    if (model === "gemini-3.8-flash") {
      const err = new Error("This model is currently experiencing high demand.");
      err.status = 503;
      throw err;
    }
    return validReply;
  };

  try {
    const result = await runGeminiReply(
      [{ role: "user", content: "Hi, HIFU weekend got slot?" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      {
        GEMINI_API_KEYS: "key-a,key-b",
        GEMINI_REPLY_5XX_RETRY_COUNT: "0",
      }
    );

    assert.equal(result, validReply);
    assert.deepEqual(calls, [
      { apiKey: "key-a", model: "gemini-3.8-flash" },
      { apiKey: "key-a", model: "gemini-3.5-flash-lite" },
    ]);
  } finally {
    geminiService.getReply = originalGetReply;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});
