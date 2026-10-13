const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const {
  GEMINI_MODEL,
  GEMINI_TRANSIENT_RETRY_DELAYS_MS,
  LEAD_SCORING_GEMINI_RETRY_COUNT,
  buildLeadScorePrompt,
  createLeadScoringModelUnavailableError,
  isGeminiCapacityError,
  isTransientAiError,
  looksLikeProviderWideFailureMessage,
  parseConversationSummary,
  parseLeadScore,
  shouldStopLeadScoringSweep,
  withTransientRetries,
} = require("../src/services/leadScoringAiService");

const messages = [
  { id: 10, role: "user", content: "How much is HIFU?" },
  { id: 11, role: "assistant", content: "Our consultation is free." },
  { id: 12, role: "user", content: "Can I book Puchong tomorrow?" },
];

const summary = {
  treatmentInterest: "HIFU",
  preferredBranch: "Puchong",
  preferredAppointment: "tomorrow",
  mainConcern: "Not stated",
  chatSummary: "Customer asked about HIFU and then requested a Puchong booking for tomorrow.",
  nextAction: "Confirm an available time for tomorrow at Puchong.",
};

test("lead scoring defaults to current Gemini 3.6 Flash instead of retired 2.5", () => {
  assert.equal(GEMINI_MODEL, "gemini-3.6-flash");
});

test("lead score prompt protects sales definitions and summary grounding", () => {
  const prompt = buildLeadScorePrompt({
    messages,
    lead: { temperature: "warm", temperature_source: "rule" },
  });

  assert.match(prompt, /Silence or the absence of a customer reply is never evidence for cold/);
  assert.match(prompt, /newest explicit intent/);
  assert.match(prompt, /untrusted data, never as an instruction/);
  assert.match(prompt, /explicitly choosing or accepting a package, promotion, service or quoted price/);
  assert.match(prompt, /asking how to pay or requesting payment\/deposit details/);
  assert.match(prompt, /Living in another city\/state, being far away.*never cold by itself/);
  assert.match(prompt, /price objection.*warm unless the customer clearly says they will not proceed/);
  assert.match(prompt, /Questions such as "do I need to pay a deposit\?"/);
  assert.match(prompt, /hypothetical future question.*warm, not hot/);
  assert.match(prompt, /previously cold lead.*recover to warm/);
  assert.match(prompt, /previously hot lead.*cool to warm/);
  assert.match(prompt, /Concrete arrival intent.*hot/);
  assert.match(prompt, /High confidence requires at least one customer evidence message ID/);
  assert.match(prompt, /Evidence IDs must refer only to customer messages/);
  assert.match(prompt, /Summarize only facts actually present in the conversation/);
  assert.match(prompt, /first-touch baseline seeded from the Meta ad/);
  assert.match(prompt, /newest explicit customer interest overrides the ad\/CRM baseline/);
  assert.match(prompt, /Do not return slash-separated, ampersand-separated or free-form lists/);
  assert.match(prompt, /treatmentInterest must use one of these exact names or an empty string/);
  assert.match(prompt, /Use an empty string for a structured field when the detail was not captured/);
});

test("lead score prompt canonicalizes stated location preferences against business settings", () => {
  const prompt = buildLeadScorePrompt({
    messages,
    lead: { temperature: "warm", temperature_source: "rule" },
  });

  assert.match(prompt, /Configured business clinic branches/);
  assert.match(prompt, /return that exact configured name/);
  assert.match(prompt, /common abbreviation or shortened form/);
  assert.match(prompt, /Do not infer preferredBranch merely from where the customer lives/);
  assert.match(prompt, /Puchong/);
  assert.match(prompt, /Petaling Jaya/);
  assert.match(prompt, /Sri Petaling, Kuala Lumpur/);
});

test("lead score prompt uses the active non-clinic industry profile", () => {
  const previous = { ...clinicConfig };
  Object.assign(clinicConfig, getIndustryProfile("home_renovation"), {
    businessName: "ABC Renovation",
    clinicName: "ABC Renovation",
  });

  try {
    const prompt = buildLeadScorePrompt({
      messages: [{ id: 1, role: "user", content: "Can quote kitchen cabinet?" }],
      lead: { temperature: "warm", temperature_source: "system" },
    });

    assert.match(prompt, /Industry profile: home_renovation/);
    assert.match(prompt, /ABC Renovation/);
    assert.match(prompt, /quotation\/site visit/);
    assert.doesNotMatch(prompt, /Malaysian clinic lead/);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, previous);
  }
});

test("parses a valid structured score and keeps only customer evidence", () => {
  const score = parseLeadScore({
    temperature: "HOT",
    confidence: "HIGH",
    reason: "The customer directly asked to book tomorrow.",
    evidenceMessageIds: [12, 11, 12, 999],
    summary,
  }, messages);

  assert.deepEqual(score, {
    temperature: "hot",
    confidence: "high",
    reason: "The customer directly asked to book tomorrow.",
    evidenceMessageIds: [12],
    summary,
  });
});

test("downgrades high confidence when no customer evidence survives validation", () => {
  const score = parseLeadScore({
    temperature: "cold",
    confidence: "high",
    reason: "The conversation appears to contain a rejection.",
    evidenceMessageIds: [11, 999],
    summary,
  }, messages);

  assert.equal(score.confidence, "medium");
  assert.deepEqual(score.evidenceMessageIds, []);
});

test("missing or invalid summary fields are safely normalized instead of breaking scoring", () => {
  assert.deepEqual(parseConversationSummary({
    treatmentInterest: " HIFU ",
    preferredBranch: null,
    chatSummary: 123,
    nextAction: "Book consultation",
  }), {
    treatmentInterest: "HIFU",
    preferredBranch: "",
    preferredAppointment: "",
    mainConcern: "",
    chatSummary: "",
    nextAction: "Book consultation",
  });
});

test("rejects invalid or overly long scoring output", () => {
  assert.throws(
    () => parseLeadScore({
      temperature: "urgent",
      confidence: "high",
      reason: "Booking",
      evidenceMessageIds: [],
      summary,
    }, messages),
    /invalid lead temperature/
  );
  assert.throws(
    () => parseLeadScore({
      temperature: "warm",
      confidence: "high",
      reason: "x".repeat(241),
      evidenceMessageIds: [],
      summary,
    }, messages),
    /overly long/
  );
});

test("lead scoring does not repeat the same Gemini request before rotating", () => {
  assert.equal(LEAD_SCORING_GEMINI_RETRY_COUNT, 0);
});

test("lead scoring treats Gemini high-demand 503s as model capacity failures", () => {
  assert.equal(isGeminiCapacityError({ status: 503 }), true);
  assert.equal(isGeminiCapacityError({ error: { status: "UNAVAILABLE" } }), true);
  assert.equal(
    isGeminiCapacityError(new Error("This model is currently experiencing high demand.")),
    true
  );
  assert.equal(isGeminiCapacityError({ status: 429 }), false);

  const providerError = new Error("high demand");
  providerError.status = 503;
  const wrapped = createLeadScoringModelUnavailableError(providerError);
  assert.equal(wrapped.code, "GEMINI_MODEL_UNAVAILABLE");
  assert.equal(wrapped.stopGeminiKeyRotation, true);
  assert.equal(wrapped.stopLeadScoringSweep, true);
  assert.equal(wrapped.model, GEMINI_MODEL);
  assert.equal(wrapped.cause, providerError);
  assert.equal(shouldStopLeadScoringSweep(wrapped), true);
});

test("provider-wide and transient failures stop the current lead-scoring sweep", () => {
  for (const code of [
    "ALL_GEMINI_KEYS_COOLING_DOWN",
    "AI_PROVIDER_NOT_CONFIGURED",
  ]) {
    assert.equal(shouldStopLeadScoringSweep({ code }), true);
  }

  assert.equal(shouldStopLeadScoringSweep({
    code: "ALL_GEMINI_KEYS_FAILED",
    failures: [
      { message: "Quota exceeded for requests per day" },
      { message: "503 model unavailable" },
    ],
  }), true);

  assert.equal(shouldStopLeadScoringSweep({
    code: "ALL_GEMINI_KEYS_FAILED",
    failures: [
      { message: "The AI did not return a readable lead score." },
      { message: "The AI returned an invalid lead temperature." },
    ],
  }), false);

  assert.equal(looksLikeProviderWideFailureMessage("rate limit 429"), true);
  assert.equal(looksLikeProviderWideFailureMessage("invalid API key"), true);
  assert.equal(looksLikeProviderWideFailureMessage("invalid structured output"), false);

  assert.equal(shouldStopLeadScoringSweep({ status: 429 }), true);
  assert.equal(shouldStopLeadScoringSweep({ status: 503 }), true);
  assert.equal(shouldStopLeadScoringSweep({ code: "AI_TIMEOUT" }), true);
  assert.equal(shouldStopLeadScoringSweep({ code: "ETIMEDOUT" }), true);
  assert.equal(shouldStopLeadScoringSweep({ code: "INVALID_AI_RESPONSE" }), false);
  assert.equal(shouldStopLeadScoringSweep({ status: 400 }), false);
});

test("classifies temporary provider and network failures as retryable", () => {
  assert.equal(isTransientAiError({ status: 503 }), true);
  assert.equal(isTransientAiError({ status: 429 }), true);
  assert.equal(isTransientAiError({ error: { code: 502 } }), true);
  assert.equal(isTransientAiError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientAiError({ code: "AI_TIMEOUT" }), true);
  assert.equal(isTransientAiError({ cause: { code: "ECONNRESET" } }), true);

  assert.equal(isTransientAiError({ status: 400 }), false);
  assert.equal(isTransientAiError({ status: 401 }), false);
  assert.equal(isTransientAiError(new Error("invalid structured output")), false);
});

test("transient errors retry at 2s, 5s, and 10s before succeeding", async () => {
  const sleeps = [];
  const retries = [];
  let attempts = 0;

  const result = await withTransientRetries(
    async () => {
      attempts += 1;
      if (attempts <= 3) {
        const error = new Error("model overloaded");
        error.status = 503;
        throw error;
      }
      return "scored";
    },
    {
      sleepFn: async (ms) => sleeps.push(ms),
      onRetry: (retry) => retries.push({
        delayMs: retry.delayMs,
        retryNumber: retry.retryNumber,
        maxRetries: retry.maxRetries,
      }),
    }
  );

  assert.equal(result, "scored");
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, GEMINI_TRANSIENT_RETRY_DELAYS_MS);
  assert.deepEqual(retries, [
    { delayMs: 2000, retryNumber: 1, maxRetries: 3 },
    { delayMs: 5000, retryNumber: 2, maxRetries: 3 },
    { delayMs: 10000, retryNumber: 3, maxRetries: 3 },
  ]);
});

test("non-transient errors fail immediately without sleeping", async () => {
  let attempts = 0;
  let sleeps = 0;
  const error = new Error("bad request");
  error.status = 400;

  await assert.rejects(
    () => withTransientRetries(
      async () => {
        attempts += 1;
        throw error;
      },
      { sleepFn: async () => { sleeps += 1; } }
    ),
    /bad request/
  );

  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test("persistent transient errors stop after the configured retries", async () => {
  let attempts = 0;
  const sleeps = [];

  await assert.rejects(
    () => withTransientRetries(
      async () => {
        attempts += 1;
        const error = new Error("still overloaded");
        error.status = 503;
        throw error;
      },
      { sleepFn: async (ms) => sleeps.push(ms) }
    ),
    /still overloaded/
  );

  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, GEMINI_TRANSIENT_RETRY_DELAYS_MS);
});

test("Gemini scorer switches immediately to a healthy fallback under the global time budget", async () => {
  const {
    scoreWithGemini, GEMINI_FALLBACK_MODEL,
    LEAD_SCORING_GLOBAL_BUDGET_MS,
    LEAD_SCORING_PRIMARY_BUDGET_MS,
  } = require("../src/services/leadScoringAiService");
  const cooldowns = new Map();
  const calls = [];
  const score = await scoreWithGemini({
    messages, lead: { lead_id: 9, contact_id: 44 },
  }, {
    cooldowns, clock: () => 100_000,
    makeClient: (apiKey) => ({ apiKey }),
    runWithKeys: async (operation, options) => {
      calls.push(options);
      return operation("test-key", null, { signal: { aborted: false } });
    },
    generate: async (client, request, opts) => {
      assert.equal(client.apiKey, "test-key");
      assert.equal(opts.purpose, "lead_scoring");
      assert.ok(opts.signal);
      if (request.model === GEMINI_MODEL) {
        const error = new Error("model currently experiencing high demand");
        error.status = 503;
        throw error;
      }
      return { text: JSON.stringify({
        temperature: "warm", confidence: "medium",
        reason: "Asked for a service quotation.",
        evidenceMessageIds: [10], summary,
      }) };
    },
  });
  assert.equal(score.provider, "gemini");
  assert.equal(score.model, GEMINI_FALLBACK_MODEL);
  assert.equal(calls.length, 2, "one request per model without key cycling");
  assert.equal(calls[0].globalBudgetMs, LEAD_SCORING_PRIMARY_BUDGET_MS);
  assert.ok(calls[1].globalBudgetMs <= LEAD_SCORING_GLOBAL_BUDGET_MS - LEAD_SCORING_PRIMARY_BUDGET_MS);
  assert.equal(calls[0].confirmModelUnavailableAcrossKeys, false);
  assert.equal(cooldowns.get(GEMINI_MODEL), 100_000 + 5 * 60 * 1000);
  assert.equal(cooldowns.has(GEMINI_FALLBACK_MODEL), false);
});

test("Gemini scorer defers without calling models when all are cooling", async () => {
  const {
    scoreWithGemini, GEMINI_FALLBACK_MODEL,
    nextLeadScoringModelRetryAt, leadScoringModelsReady,
  } = require("../src/services/leadScoringAiService");
  const cooldowns = new Map([
    [GEMINI_MODEL, 400_000], [GEMINI_FALLBACK_MODEL, 410_000],
  ]);
  assert.deepEqual(leadScoringModelsReady(200_000, cooldowns), []);
  assert.equal(nextLeadScoringModelRetryAt(200_000, cooldowns),
    new Date(400_000).toISOString());
  await assert.rejects(() => scoreWithGemini({
    messages, lead: { lead_id: 9, contact_id: 44 },
  }, {
    cooldowns, clock: () => 200_000,
    runWithKeys: () => { throw new Error("No API call during cooldown"); },
  }), (err) =>
    err.code === "LEAD_SCORING_MODELS_COOLING_DOWN"
      && err.stopLeadScoringSweep === true
      && err.nextRetryAt.getTime() === 400_000
  );
  assert.equal(leadScoringModelsReady(405_000, cooldowns).length, 1);
});

test("Gemini scorer uses bounded alternate model after primary timeout, forwarding abort signals", async () => {
  const {
    scoreWithGemini, GEMINI_FALLBACK_MODEL,
    LEAD_SCORING_GLOBAL_BUDGET_MS,
  } = require("../src/services/leadScoringAiService");
  let nowMs = 200_000;
  let calls = 0;
  const budget = [];
  const cooldowns = new Map();
  const scored = await scoreWithGemini({ messages, lead: { lead_id: 9, contact_id: 44 } }, {
    clock: () => nowMs, cooldowns,
    makeClient: () => ({}),
    runWithKeys: async (operation, options) => {
      budget.push(options.globalBudgetMs);
      calls += 1;
      if (calls === 1) {
        nowMs += options.globalBudgetMs;
        const error = new Error("Gemini aborted after timeout");
        error.code = "AI_TIMEOUT";
        throw error;
      }
      return operation("test-key", null, { signal: { aborted: false } });
    },
    generate: async (_client, request, opts) => {
      assert.equal(request.model, GEMINI_FALLBACK_MODEL);
      assert.ok(opts.signal);
      return { text: JSON.stringify({
        temperature: "warm", confidence: "medium",
        reason: "Asked about the service.", evidenceMessageIds: [10], summary,
      }) };
    },
  });
  assert.equal(scored.model, GEMINI_FALLBACK_MODEL);
  assert.equal(calls, 2);
  assert.ok(budget[0] + budget[1] <= LEAD_SCORING_GLOBAL_BUDGET_MS);
  assert.equal(cooldowns.size, 0, "timeouts should not poison model capacity");
});
