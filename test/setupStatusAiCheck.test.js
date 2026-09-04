const test = require("node:test");
const assert = require("node:assert/strict");

const aiService = require("../src/services/aiService");
const setupStatusRepo = require("../src/db/setupStatusRepo");
const geminiSetupCheck = require("../src/services/geminiSetupCheckService");
const {
  setupStatusAi,
  usesGeminiMetadataSetupCheck,
} = require("../src/routes/setupStatus");

test("setup-status Gemini check refreshes every key with metadata and never generates AI text", async () => {
  const originalCheck = geminiSetupCheck.checkAllGeminiConnections;
  const originalRecord = setupStatusRepo.recordAiCandidateSetupCheck;
  const originalGetReply = aiService.getReply;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  let metadataChecks = 0;
  let generatedReplies = 0;
  const persisted = [];

  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-setup-key";
  geminiSetupCheck.checkAllGeminiConnections = async () => {
    metadataChecks += 1;
    return {
      provider: "gemini",
      model: "gemini-2.5-flash",
      readyCount: 2,
      totalCount: 2,
      results: [
        {
          healthKey: "gemini_one",
          provider: "gemini",
          label: "Gemini key 1",
          status: "ready",
          failureKind: null,
          checkedAt: new Date("2026-09-04T04:00:00Z"),
        },
        {
          healthKey: "gemini_two",
          provider: "gemini",
          label: "Gemini key 2",
          status: "ready",
          failureKind: null,
          checkedAt: new Date("2026-09-04T04:00:00Z"),
        },
      ],
    };
  };
  setupStatusRepo.recordAiCandidateSetupCheck = async (row) => {
    persisted.push(row);
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
    assert.equal(persisted.length, 2);
    assert.deepEqual(
      persisted.map((item) => item.candidateKey),
      ["gemini_one", "gemini_two"]
    );
  } finally {
    geminiSetupCheck.checkAllGeminiConnections = originalCheck;
    setupStatusRepo.recordAiCandidateSetupCheck = originalRecord;
    aiService.getReply = originalGetReply;
    if (originalProvider == null) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalKey == null) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test("setup-status AI check fails when no Gemini metadata check is usable", async () => {
  const originalCheck = geminiSetupCheck.checkAllGeminiConnections;
  const originalRecord = setupStatusRepo.recordAiCandidateSetupCheck;
  const originalProvider = process.env.AI_PROVIDER;
  const originalKey = process.env.GEMINI_API_KEY;
  const persisted = [];

  process.env.AI_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-setup-key";
  geminiSetupCheck.checkAllGeminiConnections = async () => ({
    provider: "gemini",
    model: "gemini-2.5-flash",
    readyCount: 0,
    totalCount: 1,
    results: [
      {
        healthKey: "gemini_one",
        provider: "gemini",
        label: "Gemini key 1",
        status: "invalid",
        failureKind: "authentication",
        checkedAt: new Date("2026-09-04T04:00:00Z"),
      },
    ],
  });
  setupStatusRepo.recordAiCandidateSetupCheck = async (row) => persisted.push(row);

  try {
    await assert.rejects(
      setupStatusAi.getReply(
        [{ role: "user", content: "Private setup check: reply briefly." }],
        { channel: "whatsapp", isFirstMessage: false }
      ),
      (error) => error.code === "ALL_GEMINI_SETUP_CHECKS_FAILED"
    );
    assert.equal(persisted.length, 1);
  } finally {
    geminiSetupCheck.checkAllGeminiConnections = originalCheck;
    setupStatusRepo.recordAiCandidateSetupCheck = originalRecord;
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
