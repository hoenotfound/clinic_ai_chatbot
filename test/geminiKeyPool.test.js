const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeAttemptTimeoutMs,
  credentialFingerprint,
  getRuntimeCandidateHealth,
  resetGeminiKeyPoolState,
  runWithGeminiKeys,
} = require("../src/services/geminiKeyPool");

function quotaError(message = "Quota exceeded") {
  const err = new Error(message);
  err.status = 429;
  return err;
}

function unavailableError() {
  const err = new Error("Temporarily unavailable");
  err.status = 503;
  return err;
}

function timeoutError() {
  const err = new Error("request timed out");
  err.code = "AI_TIMEOUT";
  return err;
}

test("quota failure rotates immediately and the next request skips the cooling key", async () => {
  resetGeminiKeyPoolState();
  const nowMs = Date.parse("2026-09-04T00:00:00.000Z");
  const env = {
    GEMINI_API_KEYS: "key-a,key-b",
    GEMINI_RATE_LIMIT_COOLDOWN_MS: "60000",
  };
  const calls = [];

  const first = await runWithGeminiKeys(
    async (apiKey) => {
      calls.push(apiKey);
      if (apiKey === "key-a") throw quotaError();
      return "reply-from-b";
    },
    {
      env,
      retryCount: 1,
      persistHealth: false,
      now: () => new Date(nowMs),
    }
  );

  assert.equal(first, "reply-from-b");
  assert.deepEqual(calls, ["key-a", "key-b"]);

  calls.length = 0;
  const second = await runWithGeminiKeys(
    async (apiKey) => {
      calls.push(apiKey);
      return "next-reply";
    },
    {
      env,
      retryCount: 1,
      persistHealth: false,
      now: () => new Date(nowMs),
    }
  );

  assert.equal(second, "next-reply");
  assert.deepEqual(calls, ["key-b"]);

  const keyAHealth = getRuntimeCandidateHealth().find(
    (row) => row.candidate_key === `gemini_${credentialFingerprint("key-a")}`
  );
  assert.equal(keyAHealth.last_status, "rate_limited");
  assert.equal(keyAHealth.cooldown_until.toISOString(), "2026-09-04T00:01:00.000Z");
});

test("daily quota hints use the longer quota cooldown", async () => {
  resetGeminiKeyPoolState();
  const nowMs = Date.parse("2026-09-04T00:00:00.000Z");
  const env = {
    GEMINI_API_KEYS: "key-a,key-b",
    GEMINI_QUOTA_COOLDOWN_MS: "3600000",
  };

  await runWithGeminiKeys(
    async (apiKey) => {
      if (apiKey === "key-a") {
        throw quotaError("quota_exceeded: requests per day limit reached");
      }
      return "ok";
    },
    {
      env,
      persistHealth: false,
      now: () => new Date(nowMs),
    }
  );

  const keyAHealth = getRuntimeCandidateHealth().find(
    (row) => row.candidate_key === `gemini_${credentialFingerprint("key-a")}`
  );
  assert.equal(keyAHealth.last_failure_kind, "quota_exhausted");
  assert.equal(keyAHealth.cooldown_until.toISOString(), "2026-09-04T01:00:00.000Z");
});

test("generic temporary provider failures still retry the same key before rotating", async () => {
  resetGeminiKeyPoolState();
  const calls = [];
  const env = {
    GEMINI_API_KEYS: "key-a,key-b",
    GEMINI_UNAVAILABLE_COOLDOWN_MS: "30000",
  };

  const result = await runWithGeminiKeys(
    async (apiKey) => {
      calls.push(apiKey);
      if (apiKey === "key-a") throw unavailableError();
      return "reply-from-b";
    },
    {
      env,
      retryCount: 1,
      persistHealth: false,
      now: () => new Date("2026-09-04T00:00:00.000Z"),
    }
  );

  assert.equal(result, "reply-from-b");
  assert.deepEqual(calls, ["key-a", "key-a", "key-b"]);
});

test("smart chat policy retries a 503 once with short jitter then rotates", async () => {
  resetGeminiKeyPoolState();
  const calls = [];
  const sleeps = [];
  const env = { GEMINI_API_KEYS: "key-a,key-b" };

  const result = await runWithGeminiKeys(
    async (apiKey) => {
      calls.push(apiKey);
      if (apiKey === "key-a") throw unavailableError();
      return "reply-from-b";
    },
    {
      env,
      retryCount: 1,
      smartRetry: true,
      smartRetryDelayMinMs: 500,
      smartRetryDelayMaxMs: 1000,
      randomFn: () => 0.5,
      sleepFn: async (ms) => sleeps.push(ms),
      persistHealth: false,
    }
  );

  assert.equal(result, "reply-from-b");
  assert.deepEqual(calls, ["key-a", "key-a", "key-b"]);
  assert.deepEqual(sleeps, [750]);
});

test("smart chat policy rotates immediately on timeout instead of retrying", async () => {
  resetGeminiKeyPoolState();
  const calls = [];
  const env = { GEMINI_API_KEYS: "key-a,key-b" };

  const result = await runWithGeminiKeys(
    async (apiKey) => {
      calls.push(apiKey);
      if (apiKey === "key-a") throw timeoutError();
      return "reply-from-b";
    },
    {
      env,
      retryCount: 1,
      smartRetry: true,
      persistHealth: false,
    }
  );

  assert.equal(result, "reply-from-b");
  assert.deepEqual(calls, ["key-a", "key-b"]);
});

test("adaptive timeout reserves a usable window for later keys", () => {
  const first = computeAttemptTimeoutMs({
    remainingBudgetMs: 25000,
    candidatePosition: 0,
    totalCandidates: 5,
    preferredTimeoutMs: 8000,
    fallbackTimeoutMs: 5000,
    minRemainingKeyWindowMs: 4000,
  });
  const second = computeAttemptTimeoutMs({
    remainingBudgetMs: 17000,
    candidatePosition: 1,
    totalCandidates: 5,
    preferredTimeoutMs: 8000,
    fallbackTimeoutMs: 5000,
    minRemainingKeyWindowMs: 4000,
  });
  const third = computeAttemptTimeoutMs({
    remainingBudgetMs: 12000,
    candidatePosition: 2,
    totalCandidates: 5,
    preferredTimeoutMs: 8000,
    fallbackTimeoutMs: 5000,
    minRemainingKeyWindowMs: 4000,
  });

  assert.equal(first, 8000);
  assert.equal(second, 5000);
  assert.equal(third, 4000);
});

test("global budget stops the Gemini chain before another key attempt", async () => {
  resetGeminiKeyPoolState();
  let clockMs = 0;
  const calls = [];
  const env = { GEMINI_API_KEYS: "key-a,key-b,key-c" };

  await assert.rejects(
    () => runWithGeminiKeys(
      async (apiKey) => {
        calls.push(apiKey);
        clockMs += 6000;
        throw timeoutError();
      },
      {
        env,
        retryCount: 1,
        smartRetry: true,
        globalBudgetMs: 10000,
        preferredTimeoutMs: 6000,
        fallbackTimeoutMs: 4000,
        minRemainingKeyWindowMs: 2000,
        persistHealth: false,
        clock: () => clockMs,
      }
    ),
    (err) => err.code === "GEMINI_GLOBAL_BUDGET_EXCEEDED"
  );

  assert.deepEqual(calls, ["key-a", "key-b"]);
});

test("all cooling keys are skipped until the cooldown expires", async () => {
  resetGeminiKeyPoolState();
  let nowMs = Date.parse("2026-09-04T00:00:00.000Z");
  const env = {
    GEMINI_API_KEYS: "key-a,key-b",
    GEMINI_RATE_LIMIT_COOLDOWN_MS: "60000",
  };
  const firstCalls = [];

  await assert.rejects(
    () => runWithGeminiKeys(
      async (apiKey) => {
        firstCalls.push(apiKey);
        throw quotaError();
      },
      {
        env,
        retryCount: 1,
        persistHealth: false,
        now: () => new Date(nowMs),
      }
    ),
    (err) => err.code === "ALL_GEMINI_KEYS_FAILED"
  );
  assert.deepEqual(firstCalls, ["key-a", "key-b"]);

  let attemptedDuringCooldown = false;
  await assert.rejects(
    () => runWithGeminiKeys(
      async () => {
        attemptedDuringCooldown = true;
        return "unexpected";
      },
      {
        env,
        persistHealth: false,
        now: () => new Date(nowMs),
      }
    ),
    (err) => err.code === "ALL_GEMINI_KEYS_COOLING_DOWN"
  );
  assert.equal(attemptedDuringCooldown, false);

  nowMs += 60001;
  const recoveredCalls = [];
  const recovered = await runWithGeminiKeys(
    async (apiKey) => {
      recoveredCalls.push(apiKey);
      return "recovered";
    },
    {
      env,
      persistHealth: false,
      now: () => new Date(nowMs),
    }
  );

  assert.equal(recovered, "recovered");
  assert.deepEqual(recoveredCalls, ["key-a"]);
});
