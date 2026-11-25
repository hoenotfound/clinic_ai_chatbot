const test = require("node:test");
const assert = require("node:assert/strict");

const geminiService = require("../src/services/geminiService");
const claudeService = require("../src/services/claudeService");
const {
  DEFAULT_AI_FALLBACK_PROVIDER_RESERVE_MS,
  DEFAULT_AI_GLOBAL_BUDGET_MS,
  computeProviderBudgetMs,
  getAiReplyPolicy,
  getReplyWithEnv,
  getRuntimeGeminiModelHealth,
  resetGeminiModelHealth,
  runCandidate,
  runClaudeReply,
} = require("../src/services/aiService");
const {
  getRuntimeCandidateHealth,
  resetGeminiKeyPoolState,
} = require("../src/services/geminiKeyPool");

const VALID_REPLY = JSON.stringify({
  reply: "Hi, how can I help?",
  outcome: "normal",
  treatment: null,
  branch: null,
  appointmentPreference: null,
});

function baseEnv(overrides = {}) {
  return {
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-key-a",
    GEMINI_MODEL: "gemini-test-primary",
    GEMINI_FALLBACK_MODEL: "",
    GEMINI_REPLY_GLOBAL_BUDGET_MS: "1000",
    GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "1000",
    GEMINI_REPLY_FALLBACK_TIMEOUT_MS: "1000",
    GEMINI_REPLY_MIN_KEY_WINDOW_MS: "1",
    GEMINI_REPLY_FALLBACK_MODEL_RESERVE_MS: "0",
    GEMINI_REPLY_5XX_RETRY_COUNT: "0",
    ANTHROPIC_API_KEY: "claude-key-a",
    AI_REPLY_TIMEOUT_MS: "1000",
    AI_REPLY_RETRY_COUNT: "0",
    ...overrides,
  };
}

test("cross-provider reply policy defaults to one 30s budget with 10s reserved for fallback", () => {
  assert.equal(DEFAULT_AI_GLOBAL_BUDGET_MS, 30_000);
  assert.equal(DEFAULT_AI_FALLBACK_PROVIDER_RESERVE_MS, 10_000);
  assert.deepEqual(getAiReplyPolicy({}), {
    globalBudgetMs: 30_000,
    fallbackProviderReserveMs: 10_000,
  });
  assert.equal(computeProviderBudgetMs(30_000, true, 10_000), 20_000);
  assert.equal(computeProviderBudgetMs(8_000, true, 10_000), 1);
  assert.equal(computeProviderBudgetMs(8_000, false, 10_000), 8_000);
});

test("a hanging Gemini provider cannot consume the time reserved for Claude fallback", async () => {
  resetGeminiKeyPoolState();
  const originalGemini = geminiService.getReply;
  const originalClaude = claudeService.getReply;
  const calls = [];

  geminiService.getReply = async () => {
    calls.push("gemini");
    return new Promise(() => {});
  };
  claudeService.getReply = async () => {
    calls.push("claude");
    return VALID_REPLY;
  };

  try {
    const startedAt = Date.now();
    const result = await getReplyWithEnv(
      [{ role: "user", content: "hello" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      baseEnv({
        AI_REPLY_GLOBAL_BUDGET_MS: "120",
        AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "50",
      })
    );
    const elapsed = Date.now() - startedAt;

    assert.equal(result, VALID_REPLY);
    assert.deepEqual(calls, ["gemini", "claude"]);
    assert.ok(elapsed >= 50, `expected Gemini to receive a bounded attempt, got ${elapsed}ms`);
    assert.ok(elapsed < 300, `provider fallback exceeded the intended budget by too much: ${elapsed}ms`);
  } finally {
    geminiService.getReply = originalGemini;
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});

test("unstructured control output falls through to the next AI provider", async () => {
  resetGeminiKeyPoolState();
  const originalGemini = geminiService.getReply;
  const originalClaude = claudeService.getReply;
  const calls = [];

  geminiService.getReply = async () => {
    calls.push("gemini");
    return [
      "Hi 你好 👋",
      "",
      "3. **JSON Construction:**",
      "{\"reply\":\"internal\",\"outcome\":\"normal\"}",
    ].join("\n");
  };
  claudeService.getReply = async () => {
    calls.push("claude");
    return VALID_REPLY;
  };

  try {
    const result = await getReplyWithEnv(
      [{ role: "user", content: "hello" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      baseEnv({
        AI_REPLY_GLOBAL_BUDGET_MS: "500",
        AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "200",
        GEMINI_REPLY_5XX_RETRY_COUNT: "0",
        AI_REPLY_RETRY_COUNT: "0",
      })
    );

    assert.equal(result, VALID_REPLY);
    assert.deepEqual(calls, ["gemini", "claude"]);
  } finally {
    geminiService.getReply = originalGemini;
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});

test("structured reply with leaked internal scaffolding falls through to the next AI provider", async () => {
  resetGeminiKeyPoolState();
  const originalGemini = geminiService.getReply;
  const originalClaude = claudeService.getReply;
  const calls = [];

  geminiService.getReply = async () => {
    calls.push("gemini");
    return JSON.stringify({
      reply: [
        "你好～我可以帮你了解 😊",
        "",
        "3. **JSON Construction:**",
        "{\"outcome\":\"normal\"}",
      ].join("\n"),
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
    });
  };
  claudeService.getReply = async () => {
    calls.push("claude");
    return VALID_REPLY;
  };

  try {
    const result = await getReplyWithEnv(
      [{ role: "user", content: "hello" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      baseEnv({
        AI_REPLY_GLOBAL_BUDGET_MS: "500",
        AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "200",
        GEMINI_REPLY_5XX_RETRY_COUNT: "0",
        AI_REPLY_RETRY_COUNT: "0",
      })
    );

    assert.equal(result, VALID_REPLY);
    assert.deepEqual(calls, ["gemini", "claude"]);
  } finally {
    geminiService.getReply = originalGemini;
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});

test("Claude rate-limit failure cools the candidate and skips the next immediate attempt", async () => {
  resetGeminiKeyPoolState();
  const originalClaude = claudeService.getReply;
  let calls = 0;
  const env = baseEnv({
    AI_PROVIDER: "claude",
    GEMINI_API_KEY: "",
    CLAUDE_RATE_LIMIT_COOLDOWN_MS: "60000",
  });

  claudeService.getReply = async () => {
    calls += 1;
    const err = new Error("rate limit exceeded");
    err.status = 429;
    throw err;
  };

  try {
    await assert.rejects(
      runClaudeReply(
        [{ role: "user", content: "hello" }],
        { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
        100,
        0,
        env,
        { globalBudgetMs: 100 }
      ),
      (err) => err.status === 429
    );

    const health = getRuntimeCandidateHealth().find((row) => row.provider === "claude");
    assert.equal(health.last_status, "rate_limited");
    assert.equal(health.last_failure_kind, "rate_limit");
    assert.ok(new Date(health.cooldown_until).getTime() > Date.now());

    await assert.rejects(
      runClaudeReply(
        [{ role: "user", content: "hello again" }],
        { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
        100,
        0,
        env,
        { globalBudgetMs: 100 }
      ),
      (err) => err.code === "AI_CANDIDATE_COOLING_DOWN" && err.nextRetryAt instanceof Date
    );

    assert.equal(calls, 1);
  } finally {
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});


test("Claude 429 does not immediately retry the same limited provider", async () => {
  resetGeminiKeyPoolState();
  const originalClaude = claudeService.getReply;
  let calls = 0;
  const env = baseEnv({
    AI_PROVIDER: "claude",
    GEMINI_API_KEY: "",
    AI_REPLY_RETRY_COUNT: "1",
    CLAUDE_RATE_LIMIT_COOLDOWN_MS: "60000",
  });

  claudeService.getReply = async () => {
    calls += 1;
    const err = new Error("rate limit exceeded");
    err.status = 429;
    throw err;
  };

  try {
    await assert.rejects(
      runClaudeReply(
        [{ role: "user", content: "hello" }],
        { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
        100,
        1,
        env,
        { globalBudgetMs: 200 }
      ),
      (err) => err.status === 429
    );
    assert.equal(calls, 1);
  } finally {
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});

test("Claude transient 503 can still use one bounded retry", async () => {
  resetGeminiKeyPoolState();
  const originalClaude = claudeService.getReply;
  let calls = 0;
  const env = baseEnv({
    AI_PROVIDER: "claude",
    GEMINI_API_KEY: "",
    AI_REPLY_RETRY_COUNT: "1",
    CLAUDE_UNAVAILABLE_COOLDOWN_MS: "30000",
  });

  claudeService.getReply = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error("service unavailable");
      err.status = 503;
      throw err;
    }
    return VALID_REPLY;
  };

  try {
    const result = await runClaudeReply(
      [{ role: "user", content: "hello" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      100,
      1,
      env,
      { globalBudgetMs: 200 }
    );
    assert.equal(result, VALID_REPLY);
    assert.equal(calls, 2);
  } finally {
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});

test("a cooled Claude fallback does not steal provider reserve from healthy Gemini", async () => {
  resetGeminiKeyPoolState();
  const originalGemini = geminiService.getReply;
  const originalClaude = claudeService.getReply;
  let claudeCalls = 0;
  const env = baseEnv({
    AI_REPLY_GLOBAL_BUDGET_MS: "220",
    AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "130",
    GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "220",
    CLAUDE_RATE_LIMIT_COOLDOWN_MS: "60000",
  });

  claudeService.getReply = async () => {
    claudeCalls += 1;
    const err = new Error("rate limit exceeded");
    err.status = 429;
    throw err;
  };

  try {
    await assert.rejects(
      runClaudeReply(
        [{ role: "user", content: "prime cooldown" }],
        { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
        100,
        0,
        env,
        { globalBudgetMs: 100 }
      )
    );

    geminiService.getReply = async () => {
      await new Promise((resolve) => setTimeout(resolve, 130));
      return VALID_REPLY;
    };

    const result = await getReplyWithEnv(
      [{ role: "user", content: "hello" }],
      { channel: "whatsapp", isFirstMessage: false, privateSetupCheck: true },
      env
    );

    assert.equal(result, VALID_REPLY);
    assert.equal(claudeCalls, 1, "cooled Claude should not be attempted again");
  } finally {
    geminiService.getReply = originalGemini;
    claudeService.getReply = originalClaude;
    resetGeminiKeyPoolState();
  }
});

test("provider timeout passes a bounded request timeout and abort signal to Claude", async () => {
  let requestControl = null;
  const candidate = {
    label: "Claude fallback",
    async run(_messages, _options, control) {
      requestControl = control;
      return new Promise(() => {});
    },
  };

  await assert.rejects(
    runCandidate(candidate, [], {}, 40, 0, { globalBudgetMs: 40 }),
    (err) => err.code === "AI_TIMEOUT"
  );

  assert.ok(
    requestControl.timeoutMs > 0 && requestControl.timeoutMs <= 40,
    `expected Claude timeout to stay within the 40ms provider budget, got ${requestControl.timeoutMs}ms`
  );
  assert.equal(requestControl.signal.aborted, true);
});

test("fallback-provider retries cannot extend beyond their assigned provider budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let nowMs = 0;
  let calls = 0;
  let requestControl = null;
  const candidate = {
    label: "bounded fallback",
    async run(_messages, _options, control) {
      calls += 1;
      requestControl = control;
      return new Promise(() => {});
    },
  };

  const result = assert.rejects(
    runCandidate(
      candidate,
      [],
      {},
      1000,
      3,
      { globalBudgetMs: 60, clock: () => nowMs }
    ),
    (err) => err.code === "AI_GLOBAL_BUDGET_EXCEEDED"
  );

  assert.equal(requestControl.timeoutMs, 60);
  nowMs = 59;
  t.mock.timers.tick(59);
  assert.equal(requestControl.signal.aborted, false);
  nowMs = 60;
  t.mock.timers.tick(1);
  await result;

  assert.equal(requestControl.signal.aborted, true);
  assert.equal(calls, 1);
});

function flashLiteEnv(overrides = {}) {
  return baseEnv({
    GEMINI_API_KEY: "",
    GEMINI_API_KEYS: "key-a,key-b",
    GEMINI_MODEL: "gemini-3.8-flash",
    GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite",
    GEMINI_REPLY_GLOBAL_BUDGET_MS: "1000",
    GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "40",
    GEMINI_REPLY_FALLBACK_TIMEOUT_MS: "100",
    GEMINI_REPLY_FALLBACK_MODEL_RESERVE_MS: "100",
    GEMINI_REPLY_MIN_KEY_WINDOW_MS: "10",
    GEMINI_REPLY_5XX_RETRY_COUNT: "1",
    AI_REPLY_GLOBAL_BUDGET_MS: "1000",
    AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "200",
    ...overrides,
  });
}
function capacityError() {
  const err = new Error("This model is currently experiencing high demand.");
  err.status = 503;
  return err;
}
async function withReplyMocks(geminiMock, claudeMock, run) {
  resetGeminiKeyPoolState();
  resetGeminiModelHealth();
  const oldGemini = geminiService.getReply;
  const oldClaude = claudeService.getReply;
  geminiService.getReply = geminiMock;
  claudeService.getReply = claudeMock;
  try { await run(); } finally {
    geminiService.getReply = oldGemini;
    claudeService.getReply = oldClaude;
    resetGeminiKeyPoolState();
    resetGeminiModelHealth();
  }
}
const testReplyOptions = { channel: "whatsapp", privateSetupCheck: true };

test("primary timeout followed by valid Flash-Lite output never calls Claude", async () => {
  const calls = [];
  await withReplyMocks(async (_m, _o, _key, model) => {
    calls.push(model);
    if (model === "gemini-3.8-flash") return new Promise(() => {});
    return VALID_REPLY;
  }, async () => { calls.push("claude"); return VALID_REPLY; }, async () => {
    assert.equal(await getReplyWithEnv([], testReplyOptions, flashLiteEnv()), VALID_REPLY);
    assert.deepEqual(calls, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
  });
});

test("two failed Gemini models fall through once to Claude without Flash-Lite pool cooldown", async () => {
  const calls = [];
  const env = flashLiteEnv();
  await withReplyMocks(async (_m, _o, key, model) => {
    calls.push([key, model]);
    throw capacityError();
  }, async () => { calls.push(["claude"]); return VALID_REPLY; }, async () => {
    assert.equal(await getReplyWithEnv([], testReplyOptions, env), VALID_REPLY);
    assert.deepEqual(calls, [["key-a", "gemini-3.8-flash"], ["key-a", "gemini-3.5-flash-lite"], ["claude"]]);
    assert.equal(getRuntimeGeminiModelHealth(env).find(x => x.model === "gemini-3.5-flash-lite").status, "available");
  });
});

test("known unavailable Claude allows one corrective Flash-Lite attempt on the same key", async () => {
  const calls = [];
  const env = flashLiteEnv();
  await withReplyMocks(async (_m, _o, key, model, control) => {
    calls.push([key, model, control.correctiveRetry === true]);
    if (model === "gemini-3.8-flash") throw capacityError();
    return control.correctiveRetry ? VALID_REPLY : '{"reply":';
  }, async () => {
    calls.push(["claude"]);
    const err = new Error("rate limit exceeded"); err.status = 429; throw err;
  }, async () => {
    await assert.rejects(() => runClaudeReply([], testReplyOptions, 100, 0, env, { globalBudgetMs: 100 }));
    calls.length = 0;
    assert.equal(await getReplyWithEnv([], testReplyOptions, env), VALID_REPLY);
    assert.deepEqual(calls, [["key-a", "gemini-3.8-flash", false], ["key-a", "gemini-3.5-flash-lite", false], ["key-a", "gemini-3.5-flash-lite", true]]);
  });
});

test("Flash-Lite corrective failure never triggers a second credential sweep", async () => {
  const calls = [];
  await withReplyMocks(async (_m, _o, key, model, control) => {
    calls.push([key, model, control.correctiveRetry === true]);
    if (model === "gemini-3.8-flash") throw capacityError();
    return '{"reply":';
  }, async () => { throw Error("Claude not configured"); }, async () => {
    await assert.rejects(() => getReplyWithEnv([], testReplyOptions, flashLiteEnv({ ANTHROPIC_API_KEY: "" })));
    assert.deepEqual(calls, [["key-a", "gemini-3.8-flash", false], ["key-a", "gemini-3.5-flash-lite", false], ["key-a", "gemini-3.5-flash-lite", true]]);
  });
});

test("confirmed Flash-Lite capacity failures across two keys cool the model", async () => {
  const env = flashLiteEnv({ ANTHROPIC_API_KEY: "", GEMINI_REPLY_5XX_RETRY_COUNT: "0" });
  const calls = [];
  await withReplyMocks(async (_m, _o, key, model) => {
    calls.push([key, model]);
    throw capacityError();
  }, async () => { throw Error("Claude not configured"); }, async () => {
    await assert.rejects(() => getReplyWithEnv([], testReplyOptions, env));
    assert.deepEqual(calls, [["key-a", "gemini-3.8-flash"], ["key-a", "gemini-3.5-flash-lite"], ["key-b", "gemini-3.5-flash-lite"]]);
    assert.equal(getRuntimeGeminiModelHealth(env).find(x => x.model === "gemini-3.5-flash-lite").status, "cooling_down");
  });
});

test("insufficient remaining budget skips the first attempt of a fallback model and provider", async () => {
  const calls = [];
  let nowMs = 0;
  const env = flashLiteEnv({
    AI_REPLY_GLOBAL_BUDGET_MS: "1000", AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "100",
    GEMINI_REPLY_MIN_KEY_WINDOW_MS: "40", GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "1000",
  });
  await withReplyMocks(async (_m, _o, _key, model) => {
    calls.push(model);
    nowMs = 995;
    throw capacityError();
  }, async () => { calls.push("claude"); return VALID_REPLY; }, async () => {
    await assert.rejects(() => getReplyWithEnv([], testReplyOptions, env, { clock: () => nowMs }),
      err => err.failures.some(f => f.provider === "claude" && f.code === "AI_GLOBAL_BUDGET_EXCEEDED"));
    assert.deepEqual(calls, ["gemini-3.8-flash"]);
  });
});

test("a fallback model with a positive but unusably short remaining window is not called", async () => {
  const calls = [];
  let nowMs = 0;
  await withReplyMocks(async (_m, _o, _key, model) => {
    calls.push(model);
    nowMs = 890;
    throw capacityError();
  }, async () => { calls.push("claude"); return VALID_REPLY; }, async () => {
    const env = flashLiteEnv({ AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS: "100", GEMINI_REPLY_MIN_KEY_WINDOW_MS: "40", GEMINI_REPLY_PREFERRED_TIMEOUT_MS: "1000" });
    assert.equal(await getReplyWithEnv([], testReplyOptions, env, { clock: () => nowMs }), VALID_REPLY);
    assert.deepEqual(calls, ["gemini-3.8-flash", "claude"]);
  });
});
