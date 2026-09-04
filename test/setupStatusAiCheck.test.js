const test = require("node:test");
const assert = require("node:assert/strict");

const aiService = require("../src/services/aiService");
const geminiSetupCheck = require("../src/services/geminiSetupCheckService");
const {
  setupStatusAi,
  usesGeminiMetadataSetupCheck,
} = require("../src/routes/setupStatus");

test("setup-status Gemini check uses model metadata instead of generating AI text", async () => {
  const originalCheck = geminiSetupCheck.checkGeminiConnection;
  const originalGetReply = aiService.getReply;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  let metadataChecks = 0;
  let generatedReplies = 0;

  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-setup-key";
  geminiSetupCheck.checkGeminiConnection = async () => {
    metadataChecks += 1;
    return { provider: "gemini", model: "gemini-2.5-flash", keyLabel: "Gemini key 1" };
  };
  aiService.getReply = async () => {
    generatedReplies += 1;
    throw new Error("generateContent path should not be used");
  };

  try {
    assert.equal(usesGeminiMetadataSetupCheck(), true);
    const raw = await setupStatusAi.getReply(
      [{ role: "user", content: "Private setup check: reply briefly." }],
      { channel: "whatsapp", isFirstMessage: false }
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.reply, "OK");
    assert.equal(metadataChecks, 1);
    assert.equal(generatedReplies, 0);
  } finally {
    geminiSetupCheck.checkGeminiConnection = originalCheck;
    aiService.getReply = originalGetReply;
    if (originalProvider == null) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("non-Gemini preferred provider retains the existing private provider check", async () => {
  const originalGetReply = aiService.getReply;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  let received = null;

  process.env.AI_PROVIDER = "claude";
  process.env.GEMINI_API_KEY = "test-setup-key";
  aiService.getReply = async (messages, options) => {
    received = { messages, options };
    return JSON.stringify({
      reply: "OK",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
    });
  };

  try {
    assert.equal(usesGeminiMetadataSetupCheck(), false);
    await setupStatusAi.getReply(
      [{ role: "user", content: "Private setup check: reply briefly." }],
      { channel: "whatsapp", isFirstMessage: false }
    );
    assert.equal(received.options.privateSetupCheck, true);
  } finally {
    aiService.getReply = originalGetReply;
    if (originalProvider == null) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});
