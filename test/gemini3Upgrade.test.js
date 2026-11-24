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
  // Background fallback must stay independent of an emergency rollback of the
  // customer reply GEMINI_MODEL environment variable.
  assert.doesNotMatch(
    leadScoringSource,
    /LEAD_SCORING_GEMINI_FALLBACK_MODEL[\s\S]{0,80}process\.env\.GEMINI_MODEL/
  );
  // Scoring has a dedicated 3.6 primary and a 3.8 fallback; 3.8 rejects
  // minimal thinking, so model-specific selection is mandatory.
  assert.match(
    leadScoringSource,
    /thinkingConfig: \{ thinkingLevel: leadScoringThinkingLevel\(model\) \}/
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

test("Gemini reply models use model-specific thinking defaults", () => {
  assert.deepEqual(
    geminiService.buildThinkingConfig("gemini-3.8-flash", {}),
    { thinkingLevel: "low" }
  );
  assert.deepEqual(
    geminiService.buildThinkingConfig("gemini-3.5-flash-lite", {}),
    { thinkingLevel: "minimal" }
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

test("default 3.8 capacity failure switches directly to 3.5 Flash-Lite", async () => {
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

test("Flash-Lite uses a larger output allowance and the correct structured schema for each reply surface", () => {
  const messages = [{ role: "user", content: "多少钱？" }];
  for (const surface of ["conversation", "follow_up"]) {
    const { request } = geminiService.buildGeminiRequest(messages, { surface }, "gemini-3.5-flash-lite");
    assert.equal(request.config.maxOutputTokens, 2048);
    assert.equal(request.config.responseMimeType, "application/json");
    assert.ok(request.config.responseJsonSchema);
    if (surface === "conversation") {
      for (const field of ["reply", "outcome", "serviceQuery", "serviceQuerySource", "priceQuery", "packageQuery", "pricingStage", "reviewType", "promotionOption", "treatment", "branch", "appointmentPreference", "projectLocation", "projectSummary", "nextStep", "staffSummary"]) {
        assert.ok(request.config.responseJsonSchema.required.includes(field), field);
      }
    } else {
      assert.deepEqual(request.config.responseJsonSchema.required, ["action", "message", "reason", "topic"]);
    }
  }
  const { request } = geminiService.buildGeminiRequest(messages, {}, "gemini-3.8-flash");
  assert.equal(request.config.maxOutputTokens, 1200);
  assert.equal(request.config.responseJsonSchema, undefined);
  assert.deepEqual(geminiService.buildThinkingConfig("gemini-3.5-flash-lite", { GEMINI_FLASH_LITE_THINKING_LEVEL: "low" }), { thinkingLevel: "low" });
  assert.deepEqual(geminiService.buildThinkingConfig("gemini-3.5-flash-lite", { GEMINI_FLASH_LITE_THINKING_LEVEL: "bad" }), { thinkingLevel: "minimal" });
});

test("Flash-Lite invalid JSON is not retried or rotated across credentials", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const original = geminiService.getReply;
  const calls = [];
  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    if (model === "gemini-3.8-flash") {
      const err = new Error("This model is currently experiencing high demand.");
      err.status = 503;
      throw err;
    }
    return '{"reply":';
  };
  try {
    await assert.rejects(() => runGeminiReply([{ role: "user", content: "Hi" }],
      { channel: "whatsapp", privateSetupCheck: true }, { GEMINI_API_KEYS: "key-a,key-b", GEMINI_REPLY_5XX_RETRY_COUNT: "1" },
      { hasLaterProvider: true }));
    assert.deepEqual(calls, [
      { apiKey: "key-a", model: "gemini-3.8-flash" },
      { apiKey: "key-a", model: "gemini-3.5-flash-lite" },
    ]);
  } finally {
    geminiService.getReply = original;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});

test("when another provider is available, a final Gemini capacity failure does not retry or rotate keys", async () => {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const original = geminiService.getReply;
  const calls = [];
  geminiService.getReply = async (_messages, _options, apiKey, model) => {
    calls.push({ apiKey, model });
    const err = new Error("This model is currently experiencing high demand.");
    err.status = 503;
    throw err;
  };
  try {
    await assert.rejects(() => runGeminiReply([{ role: "user", content: "Hi" }],
      { channel: "whatsapp", privateSetupCheck: true }, { GEMINI_API_KEYS: "key-a,key-b", GEMINI_REPLY_5XX_RETRY_COUNT: "1" },
      { hasLaterProvider: true }));
    assert.deepEqual(calls, [
      { apiKey: "key-a", model: "gemini-3.8-flash" },
      { apiKey: "key-a", model: "gemini-3.5-flash-lite" },
    ]);
  } finally {
    geminiService.getReply = original;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
});
