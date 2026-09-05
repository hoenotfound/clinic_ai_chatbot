const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createGeminiInteraction,
  failureKind,
  generateGeminiContent,
  usageFromInteraction,
  usageFromResponse,
} = require("../src/services/aiUsageService");

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Gemini GenerateContent usage metadata is normalized", () => {
  assert.deepEqual(
    usageFromResponse({
      usageMetadata: {
        promptTokenCount: 1200,
        candidatesTokenCount: 180,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: 300,
        totalTokenCount: 1380,
      },
    }),
    {
      promptTokens: 1200,
      outputTokens: 180,
      thinkingTokens: 0,
      cachedTokens: 300,
      totalTokens: 1380,
    }
  );
});

test("Gemini Interactions usage metadata is normalized", () => {
  assert.deepEqual(
    usageFromInteraction({
      usage: {
        total_input_tokens: 900,
        total_output_tokens: 120,
        total_thought_tokens: 0,
        total_cached_tokens: 50,
        total_tokens: 1020,
      },
    }),
    {
      promptTokens: 900,
      outputTokens: 120,
      thinkingTokens: 0,
      cachedTokens: 50,
      totalTokens: 1020,
    }
  );
});

test("successful Gemini GenerateContent calls record provider usage", async () => {
  const recorded = [];
  const repository = {
    async recordAiUsage(event) { recorded.push(event); },
  };
  const database = { query() { throw new Error("not used"); } };
  let now = 1000;
  const response = {
    text: "ok",
    usageMetadata: {
      promptTokenCount: 240,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 0,
      cachedContentTokenCount: 10,
      totalTokenCount: 260,
    },
  };
  const ai = {
    models: {
      async generateContent() {
        now = 1125;
        return response;
      },
    },
  };

  const result = await generateGeminiContent(
    ai,
    { model: "gemini-3.8-flash", contents: "hello" },
    {
      purpose: "customer_reply",
      database,
      repository,
      clock: () => now,
    }
  );
  await flushPromises();

  assert.equal(result, response);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    provider: "gemini",
    model: "gemini-3.8-flash",
    purpose: "customer_reply",
    status: "success",
    failureKind: null,
    latencyMs: 125,
    promptTokens: 240,
    outputTokens: 20,
    thinkingTokens: 0,
    cachedTokens: 10,
    totalTokens: 260,
  });
});

test("successful Gemini Interactions calls preserve voice-transcription usage telemetry", async () => {
  const recorded = [];
  const repository = {
    async recordAiUsage(event) { recorded.push(event); },
  };
  const database = { query() { throw new Error("not used"); } };
  let now = 2000;
  const interaction = {
    output_text: "boleh book esok?",
    usage: {
      total_input_tokens: 300,
      total_output_tokens: 12,
      total_thought_tokens: 0,
      total_cached_tokens: 0,
      total_tokens: 312,
    },
  };
  const ai = {
    interactions: {
      async create(request) {
        assert.equal(request.model, "gemini-3.5-transcribe");
        now = 2150;
        return interaction;
      },
    },
  };

  const result = await createGeminiInteraction(
    ai,
    {
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", uri: "https://example.test/file", mime_type: "audio/mpeg" }],
    },
    {
      purpose: "voice_transcription",
      database,
      repository,
      clock: () => now,
    }
  );
  await flushPromises();

  assert.equal(result, interaction);
  assert.deepEqual(recorded[0], {
    provider: "gemini",
    model: "gemini-3.5-transcribe",
    purpose: "voice_transcription",
    status: "success",
    failureKind: null,
    latencyMs: 150,
    promptTokens: 300,
    outputTokens: 12,
    thinkingTokens: 0,
    cachedTokens: 0,
    totalTokens: 312,
  });
});

test("failed Gemini requests are counted for quota monitoring without inventing token usage", async () => {
  const recorded = [];
  const repository = {
    async recordAiUsage(event) { recorded.push(event); },
  };
  const database = { query() { throw new Error("not used"); } };
  const error = new Error("This model is currently experiencing high demand.");
  error.status = 503;
  const ai = {
    models: {
      async generateContent() { throw error; },
    },
  };

  await assert.rejects(
    generateGeminiContent(
      ai,
      { model: "gemini-3.8-flash", contents: "hello" },
      { purpose: "customer_reply", database, repository }
    ),
    (err) => err === error
  );
  await flushPromises();

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, "failed");
  assert.equal(recorded[0].failureKind, "model_unavailable");
  assert.equal(recorded[0].totalTokens, 0);
  assert.equal(failureKind(error), "model_unavailable");
});

test("failed Gemini Interactions calls use the same failure classification", async () => {
  const recorded = [];
  const repository = {
    async recordAiUsage(event) { recorded.push(event); },
  };
  const database = { query() { throw new Error("not used"); } };
  const error = new Error("Too many requests");
  error.status = 429;
  const ai = {
    interactions: {
      async create() { throw error; },
    },
  };

  await assert.rejects(
    createGeminiInteraction(
      ai,
      { model: "gemini-3.5-transcribe", input: [] },
      { purpose: "voice_transcription", database, repository }
    ),
    (err) => err === error
  );
  await flushPromises();

  assert.equal(recorded[0].status, "failed");
  assert.equal(recorded[0].failureKind, "rate_limit");
  assert.equal(recorded[0].totalTokens, 0);
});

test("usage monitoring distinguishes daily quota exhaustion from short rate limiting", () => {
  const quotaError = new Error("Quota exceeded: requests per day (RPD) limit reached.");
  quotaError.error = { code: "quota_exceeded" };
  assert.equal(failureKind(quotaError), "quota_exhausted");

  const rateError = new Error("Too many requests; please retry shortly.");
  rateError.status = 429;
  assert.equal(failureKind(rateError), "rate_limit");
});
