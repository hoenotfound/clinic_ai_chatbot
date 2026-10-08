const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createGeminiInteraction,
  failureKind,
  generateGeminiContent,
  promptPrefixFingerprint,
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
      cacheMetadataPresent: true,
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
      cacheMetadataPresent: true,
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
    cacheMetadataPresent: true,
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
    cacheMetadataPresent: true,
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

  const freeTierRpdError = new Error(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}}'
  );
  freeTierRpdError.status = 429;
  assert.equal(failureKind(freeTierRpdError), "quota_exhausted");

  const rateError = new Error("Too many requests; please retry shortly.");
  rateError.status = 429;
  assert.equal(failureKind(rateError), "rate_limit");
});

test("Gemini cache metadata distinguishes an explicit zero from an omitted count", () => {
  assert.deepEqual(
    { cached: usageFromResponse({usageMetadata:{cachedContentTokenCount:0}}).cachedTokens,
      present: usageFromResponse({usageMetadata:{cachedContentTokenCount:0}}).cacheMetadataPresent },
    { cached:0, present:true }
  );
  assert.equal(usageFromResponse({usageMetadata:{promptTokenCount:1200}}).cacheMetadataPresent,false);
  assert.equal(usageFromResponse({}).cacheMetadataPresent,false);
  assert.equal(usageFromResponse({usageMetadata:{cachedContentTokenCount:null}}).cacheMetadataPresent,false);
  assert.equal(usageFromInteraction({usage:{total_cached_tokens:0}}).cacheMetadataPresent,true);
  assert.equal(usageFromInteraction({usage:{totalCachedTokens:0}}).cacheMetadataPresent,true);
  assert.equal(usageFromInteraction({usage:{total_input_tokens:100}}).cacheMetadataPresent,false);
});

test("prompt fingerprint is stable for repeated common prefixes and never includes full prompt", () => {
  const a = {config:{systemInstruction:"A".repeat(8192) + "骨盆咨询 for a customer"}};
  const b = {config:{systemInstruction:"A".repeat(8192) + "3D pricing for another customer"}};
  const c = {config:{systemInstruction:"A".repeat(8191) + "B" + "3D pricing"}};
  const fingerprint = promptPrefixFingerprint(a);
  assert.match(fingerprint,/^[a-f0-9]{16}$/);
  assert.equal(promptPrefixFingerprint(b),fingerprint);
  assert.notEqual(promptPrefixFingerprint(c),fingerprint);
  assert.equal(promptPrefixFingerprint({config:{}}),null);
});

test("Gemini usage event persists only an opaque prompt prefix fingerprint", async () => {
  const recorded=[];
  const repository={async recordAiUsage(event){recorded.push(event);}};
  const source="A".repeat(9000);
  const result=await generateGeminiContent(
    {models:{async generateContent(){return {usageMetadata:{cachedContentTokenCount:0,promptTokenCount:100}};}}},
    {model:"gemini-3.8-flash",contents:[{role:"user",parts:[{text:"private patient request"}]}],config:{systemInstruction:source}},
    {purpose:"customer_reply",database:{},repository}
  );
  assert.ok(result.usageMetadata);
  await flushPromises();
  assert.equal(recorded.length,1);
  assert.equal(recorded[0].cacheMetadataPresent,true);
  assert.equal(recorded[0].cachedTokens,0);
  assert.equal(recorded[0].promptPrefixHash,promptPrefixFingerprint({config:{systemInstruction:source}}));
  assert.equal(JSON.stringify(recorded[0]).includes("private patient"),false);
});
