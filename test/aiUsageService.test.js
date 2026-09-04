const test = require("node:test");
const assert = require("node:assert/strict");

const {
  failureKind,
  generateGeminiContent,
  usageFromResponse,
} = require("../src/services/aiUsageService");

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("Gemini usage metadata is normalized into prompt/output/thinking/total tokens", () => {
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

test("successful Gemini calls record actual provider usage metadata without delaying the result", async () => {
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
    { model: "gemini-2.5-flash", contents: "hello" },
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
    model: "gemini-2.5-flash",
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
      { model: "gemini-2.5-flash", contents: "hello" },
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

test("usage monitoring distinguishes daily quota exhaustion from short rate limiting", () => {
  const quotaError = new Error("Quota exceeded: requests per day (RPD) limit reached.");
  quotaError.error = { code: "quota_exceeded" };
  assert.equal(failureKind(quotaError), "quota_exhausted");

  const rateError = new Error("Too many requests; please retry shortly.");
  rateError.status = 429;
  assert.equal(failureKind(rateError), "rate_limit");
});
