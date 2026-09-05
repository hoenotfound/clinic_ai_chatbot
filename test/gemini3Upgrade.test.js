const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const geminiService = require("../src/services/geminiService");
const {
  DEFAULT_GEMINI_ALTERNATE_MODEL,
  DEFAULT_GEMINI_MODEL,
  getGeminiReplyModels,
  resetGeminiModelHealth,
  runGeminiReply,
} = require("../src/services/aiService");
const { resetGeminiKeyPoolState } = require("../src/services/geminiKeyPool");
const {
  DEFAULT_MODEL: DEFAULT_SETUP_CHECK_MODEL,
  checkGeminiConnection,
} = require("../src/services/geminiSetupCheckService");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("Gemini 3 production defaults are pinned and require no model env variables", () => {
  assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.8-flash");
  assert.equal(DEFAULT_GEMINI_ALTERNATE_MODEL, "gemini-3.5-flash-lite");
  assert.equal(DEFAULT_SETUP_CHECK_MODEL, DEFAULT_GEMINI_MODEL);
  assert.deepEqual(
    getGeminiReplyModels({}),
    ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
  );
});

test("complete emergency 2.5 rollback keeps both customer reply models on 2.5", () => {
  assert.deepEqual(
    getGeminiReplyModels({
      GEMINI_MODEL: "gemini-2.5-flash",
      GEMINI_FALLBACK_MODEL: "gemini-2.5-flash-lite",
    }),
    ["gemini-2.5-flash", "gemini-2.5-flash-lite"]
  );
});

test("background Gemini tasks are isolated from the customer reply model override", () => {
  const leadScoringSource = source("src/services/leadScoringAiService.js");
  assert.match(
    leadScoringSource,
    /LEAD_SCORING_GEMINI_MODEL \|\| "gemini-3\.6-flash"/
  );
  assert.doesNotMatch(
    leadScoringSource,
    /LEAD_SCORING_GEMINI_MODEL \|\| process\.env\.GEMINI_MODEL/
  );
  assert.match(
    leadScoringSource,
    /thinkingConfig: \{ thinkingLevel: "minimal" \}/
  );

  const translationSource = source("src/services/followUpTranslationService.js");
  assert.match(
    translationSource,
    /FOLLOW_UP_TRANSLATION_GEMINI_MODEL \|\| "gemini-3\.6-flash"/
  );
  assert.doesNotMatch(
    translationSource,
    /process\.env\.GEMINI_MODEL \|\| "gemini-/
  );
  assert.match(
    translationSource,
    /thinkingConfig: \{ thinkingLevel: "minimal" \}/
  );

  const transcriptionSource = source("src/services/transcriptionService.js");
  assert.match(
    transcriptionSource,
    /DEFAULT_TRANSCRIPTION_MODEL = "gemini-3\.5-transcribe"/
  );
  assert.doesNotMatch(
    transcriptionSource,
    /GEMINI_TRANSCRIBE_MODEL \|\| process\.env\.GEMINI_MODEL/
  );
});

test("Setup Status checks the same 3.8 primary when no model env override exists", async () => {
  const calls = [];
  const result = await checkGeminiConnection({
    env: { GEMINI_API_KEY: "test-key" },
    createClient() {
      return {
        models: {
          async get(params) {
            calls.push(params);
            return { name: "models/gemini-3.8-flash", supportedActions: ["generateContent"] };
          },
        },
      };
    },
  });

  assert.deepEqual(calls, [{ model: "gemini-3.8-flash" }]);
  assert.equal(result.model, "gemini-3.8-flash");
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
