const test = require("node:test");
const assert = require("node:assert/strict");

const {
  credentialFingerprint,
  getRuntimeCandidateHealth,
  resetGeminiKeyPoolState,
  runWithGeminiKeys,
} = require("../src/services/geminiKeyPool");

function quotaError() {
  const err = new Error("Quota exceeded");
  err.status = 429;
  return err;
}

function unavailableError() {
  const err = new Error("Temporarily unavailable");
  err.status = 503;
  return err;
}

test("quota failure rotates immediately and the next request skips the cooling key", async () => {
  resetGeminiKeyPoolState();
  let nowMs = Date.parse("2026-09-04T00:00:00.000Z");
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

test("temporary provider failures retry the same key before rotating", async () => {
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