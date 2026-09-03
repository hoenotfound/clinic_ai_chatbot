const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSetupStatusService,
  safeError,
} = require("../src/services/setupStatusService");
const { credentialFingerprint } = require("../src/services/aiService");
const { requireAdministrator } = require("../src/routes/setupStatus");

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function completeEnv() {
  return {
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-secret-value",
    GEMINI_API_KEY_1: "rotated-gemini-secret-value",
    ANTHROPIC_API_KEY: "claude-secret-value",
    SESSION_SECRET: "a-strong-random-session-secret-with-more-than-32-characters",
    PUBLIC_BASE_URL: "https://clinic.example.test",
    WHATSAPP_PHONE_NUMBER_ID: "10001",
    WHATSAPP_TOKEN: "whatsapp-secret-token",
    WHATSAPP_APP_SECRET: "whatsapp-app-secret",
    WHATSAPP_VERIFY_TOKEN: "whatsapp-verify-secret",
    FACEBOOK_PAGE_ID: "20002",
    FACEBOOK_PAGE_ACCESS_TOKEN: "facebook-secret-token",
    INSTAGRAM_PAGE_ID: "30003",
    INSTAGRAM_PAGE_ACCESS_TOKEN: "instagram-secret-token",
    META_APP_SECRET: "meta-app-secret",
    META_VERIFY_TOKEN: "meta-verify-secret",
    R2_ACCOUNT_ID: "r2-account",
    R2_ACCESS_KEY_ID: "r2-access-secret",
    R2_SECRET_ACCESS_KEY: "r2-private-secret",
    R2_BUCKET_NAME: "private-bucket",
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "123456:telegram-secret-token",
    TELEGRAM_CHAT_ID: "-100123456",
    META_MARKETING_ACCESS_TOKEN: "marketing-secret-token",
  };
}

function memoryRepository(initial = [], candidateInitial = []) {
  const rows = new Map(initial.map((row) => [row.check_key, { ...row }]));
  const candidateRows = new Map(
    candidateInitial.map((row) => [row.candidate_key, { ...row }])
  );
  return {
    rows,
    candidateRows,
    async listConnectionHealth() {
      return [...rows.values()];
    },
    async saveCheckResults(results) {
      for (const item of results) {
        const previous = rows.get(item.key) || { check_key: item.key };
        rows.set(item.key, {
          ...previous,
          last_check_status: item.status,
          last_check_summary: item.summary,
          last_checked_at: item.checkedAt,
          last_success_at: item.status === "ready"
            ? item.checkedAt
            : previous.last_success_at || null,
        });
      }
    },
    async listAiCandidateHealth() {
      return [...candidateRows.values()];
    },
  };
}

test("runs safe checks without exposing credentials or messaging customers", async () => {
  const env = completeEnv();
  const webhookAt = "2026-09-03T10:00:00.000Z";
  const repository = memoryRepository([
    { check_key: "whatsapp_webhook", last_webhook_at: webhookAt },
    { check_key: "meta_webhook", last_webhook_at: webhookAt },
  ]);
  const requested = [];
  const deleted = [];
  const service = createSetupStatusService({
    env,
    repository,
    now: () => new Date("2026-09-03T12:00:00.000Z"),
    database: {
      async query(sql) {
        if (/COUNT/.test(sql)) return { rows: [{ count: 1 }] };
        if (/SELECT meta_ad_id/.test(sql)) {
          return { rows: [{ meta_ad_id: "120210000001234" }] };
        }
        return { rows: [{ ok: 1 }] };
      },
    },
    ai: {
      getGeminiApiKeys: () => [env.GEMINI_API_KEY],
      async getReply() { return "Setup test successful."; },
    },
    storage: {
      async uploadMedia(buffer, mimeType, options) {
        assert.equal(buffer.toString(), "clinic-ai-setup-check");
        assert.equal(mimeType, "text/plain");
        assert.equal(options.contactId, "setup-check");
        return "messages/setup-check/object.bin";
      },
      async deleteMedia(key) { deleted.push(key); },
    },
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      if (url.includes("api.telegram.org") && url.endsWith("/getMe")) {
        return response({ ok: true, result: { username: "clinic_alert_bot" } });
      }
      if (url.includes("api.telegram.org") && url.includes("/getChat")) {
        return response({ ok: true, result: { id: -100123456 } });
      }
      if (url.includes("/10001?")) {
        return response({ id: "10001", verified_name: "Clinic Test" });
      }
      if (url.includes("/20002?")) return response({ id: "20002", name: "Clinic Page" });
      if (url.includes("/30003?")) return response({ id: "30003", name: "Clinic IG Page" });
      if (url.includes("/me?")) return response({ id: "system-user" });
      if (url.includes("/120210000001234?")) {
        return response({ id: "120210000001234", name: "Clinic Ad", account_id: "123456789" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const status = await service.runAll({ requestBaseUrl: "https://detected.example.test" });
  const byKey = new Map(status.checks.map((item) => [item.key, item]));

  assert.equal(status.summary.requiredReady, status.summary.requiredTotal);
  assert.equal(status.lastRunAt, "2026-09-03T12:00:00.000Z");
  assert.equal(byKey.get("whatsapp").status, "ready");
  assert.equal(byKey.get("facebook").status, "ready");
  assert.equal(byKey.get("instagram").status, "ready");
  assert.equal(byKey.get("telegram").status, "ready");
  assert.equal(byKey.get("r2").status, "ready");
  assert.equal(byKey.get("meta_marketing").status, "ready");
  assert.equal(byKey.get("whatsapp_webhook").lastWebhookAt, webhookAt);
  assert.deepEqual(deleted, ["messages/setup-check/object.bin"]);

  const payload = JSON.stringify(status);
  for (const secret of [
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_1,
    env.ANTHROPIC_API_KEY,
    env.WHATSAPP_TOKEN,
    env.FACEBOOK_PAGE_ACCESS_TOKEN,
    env.INSTAGRAM_PAGE_ACCESS_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    env.META_MARKETING_ACCESS_TOKEN,
    env.R2_SECRET_ACCESS_KEY,
  ]) {
    assert.equal(payload.includes(secret), false);
  }
  assert.equal(requested.some(({ url }) => /\/messages(?:\?|$)/.test(url)), false);
  assert.equal(requested.some(({ url }) => /sendMessage/i.test(url)), false);
});

test("unconfigured optional services do not make network requests", async () => {
  let fetchCalls = 0;
  const env = {
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "configured-ai-key",
    SESSION_SECRET: "another-strong-random-session-secret-over-32-characters",
    PUBLIC_BASE_URL: "https://clinic.example.test",
    WHATSAPP_PHONE_NUMBER_ID: "10001",
    WHATSAPP_TOKEN: "whatsapp-token",
    WHATSAPP_APP_SECRET: "app-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-secret",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET_NAME: "bucket",
  };
  const service = createSetupStatusService({
    env,
    repository: memoryRepository([
      { check_key: "whatsapp_webhook", last_webhook_at: "2026-09-03T10:00:00.000Z" },
    ]),
    database: {
      async query(sql) {
        return /COUNT/.test(sql) ? { rows: [{ count: 1 }] } : { rows: [{ ok: 1 }] };
      },
    },
    ai: { async getReply() { return "ok"; } },
    storage: {
      async uploadMedia() { return "test-key"; },
      async deleteMedia() {},
    },
    fetchImpl: async (url) => {
      fetchCalls += 1;
      assert.match(url, /\/10001\?/);
      return response({ id: "10001", verified_name: "Clinic Test" });
    },
  });

  const status = await service.runAll();
  const byKey = new Map(status.checks.map((item) => [item.key, item]));
  assert.equal(fetchCalls, 1);
  assert.equal(byKey.get("facebook").status, "not_configured");
  assert.equal(byKey.get("instagram").status, "not_configured");
  assert.equal(byKey.get("telegram").status, "not_configured");
  assert.equal(byKey.get("meta_marketing").status, "not_configured");
});

test("provider errors are shown safely and prior success is preserved", async () => {
  const repository = memoryRepository([
    {
      check_key: "whatsapp",
      last_success_at: "2026-09-02T09:00:00.000Z",
      last_check_status: "ready",
      last_check_summary: "Previously connected.",
      last_checked_at: "2026-09-02T09:00:00.000Z",
    },
  ]);
  const env = completeEnv();
  const service = createSetupStatusService({
    env,
    repository,
    database: {
      async query(sql) {
        return /COUNT/.test(sql) ? { rows: [{ count: 1 }] } : { rows: [{ ok: 1 }] };
      },
    },
    ai: { async getReply() { return "ok"; } },
    storage: {
      async uploadMedia() { return "test-key"; },
      async deleteMedia() {},
    },
    fetchImpl: async () => response(
      { error: { message: "Invalid OAuth access token Bearer secret-token" } },
      { ok: false, status: 401 }
    ),
  });

  const status = await service.runAll();
  const whatsapp = status.checks.find((item) => item.key === "whatsapp");
  assert.equal(whatsapp.status, "error");
  assert.equal(whatsapp.lastSuccessAt, "2026-09-02T09:00:00.000Z");
  assert.equal(JSON.stringify(whatsapp).includes("secret-token"), false);
  assert.match(whatsapp.summary, /\[hidden\]/);
});

test("overview reports the persisted last run instead of the page-load time", async () => {
  const service = createSetupStatusService({
    env: completeEnv(),
    now: () => new Date("2026-09-03T12:00:00.000Z"),
    repository: memoryRepository([
      {
        check_key: "database",
        last_check_status: "ready",
        last_check_summary: "Connected.",
        last_checked_at: "2026-09-02T08:30:00.000Z",
        last_success_at: "2026-09-02T08:30:00.000Z",
      },
    ]),
  });

  const status = await service.getOverview();
  assert.equal(status.checkedAt, "2026-09-03T12:00:00.000Z");
  assert.equal(status.lastRunAt, "2026-09-02T08:30:00.000Z");
});

test("overview exposes masked candidate health without any key material", async () => {
  const env = completeEnv();
  const candidateKey = `gemini_${credentialFingerprint(env.GEMINI_API_KEY)}`;
  const service = createSetupStatusService({
    env,
    now: () => new Date("2026-09-03T12:00:00.000Z"),
    repository: memoryRepository([], [
      {
        candidate_key: candidateKey,
        provider: "gemini",
        last_status: "rate_limited",
        last_failure_kind: "rate_limit",
        last_attempt_at: "2026-09-03T11:30:00.000Z",
        last_success_at: "2026-09-03T09:00:00.000Z",
        last_failure_at: "2026-09-03T11:30:00.000Z",
        last_rate_limited_at: "2026-09-03T11:30:00.000Z",
      },
    ]),
  });

  const status = await service.getOverview();
  const ai = status.checks.find((check) => check.key === "ai");
  assert.equal(ai.candidateHealth[0].label, "Gemini key 1");
  assert.equal(ai.candidateHealth[0].status, "rate_limited");
  assert.equal(ai.candidateHealth[0].lastRateLimitedAt, "2026-09-03T11:30:00.000Z");
  assert.equal(JSON.stringify(status).includes(env.GEMINI_API_KEY), false);
  assert.equal(JSON.stringify(status).includes(candidateKey), false);
});

test("provider errors redact configured secrets even when echoed without a Bearer prefix", async () => {
  const env = completeEnv();
  const service = createSetupStatusService({
    env,
    repository: memoryRepository(),
    database: {
      async query(sql) {
        return /COUNT/.test(sql) ? { rows: [{ count: 1 }] } : { rows: [{ ok: 1 }] };
      },
    },
    ai: {
      async getReply() {
        throw new Error(`AI rejected key ${env.GEMINI_API_KEY_1}`);
      },
    },
    storage: {
      async uploadMedia() { return "test-key"; },
      async deleteMedia() {},
    },
    fetchImpl: async () => response({ id: "connected" }),
  });

  const status = await service.runAll();
  const ai = status.checks.find((check) => check.key === "ai");
  assert.equal(ai.summary.includes(env.GEMINI_API_KEY_1), false);
  assert.match(ai.summary, /\[hidden\]/);
});

test("Meta Ads stays cautious until access to a captured Ad can be verified", async () => {
  const env = completeEnv();
  const service = createSetupStatusService({
    env,
    repository: memoryRepository(),
    database: {
      async query(sql) {
        if (/COUNT/.test(sql)) return { rows: [{ count: 1 }] };
        if (/SELECT meta_ad_id/.test(sql)) return { rows: [] };
        return { rows: [{ ok: 1 }] };
      },
    },
    ai: { async getReply() { return "ok"; } },
    storage: {
      async uploadMedia() { return "test-key"; },
      async deleteMedia() {},
    },
    fetchImpl: async (url) => {
      if (url.includes("api.telegram.org")) return response({ ok: true, result: {} });
      return response({ id: url.includes("/me?") ? "system-user" : "connected", name: "Connected" });
    },
  });

  const status = await service.runAll();
  const meta = status.checks.find((check) => check.key === "meta_marketing");
  assert.equal(meta.status, "warning");
  assert.match(meta.summary, /Capture a Meta Ad ID/);
});

test("Meta Ads reports missing ads_read or ad account access", async () => {
  const env = completeEnv();
  const service = createSetupStatusService({
    env,
    repository: memoryRepository(),
    database: {
      async query(sql) {
        if (/COUNT/.test(sql)) return { rows: [{ count: 1 }] };
        if (/SELECT meta_ad_id/.test(sql)) {
          return { rows: [{ meta_ad_id: "120210000001234" }] };
        }
        return { rows: [{ ok: 1 }] };
      },
    },
    ai: { async getReply() { return "ok"; } },
    storage: {
      async uploadMedia() { return "test-key"; },
      async deleteMedia() {},
    },
    fetchImpl: async (url) => {
      if (url.includes("/me?")) return response({ id: "system-user" });
      if (url.includes("/120210000001234?")) {
        return response(
          { error: { message: "Missing permission" } },
          { ok: false, status: 403 }
        );
      }
      if (url.includes("api.telegram.org")) return response({ ok: true, result: {} });
      return response({ id: "connected", name: "Connected" });
    },
  });

  const status = await service.runAll();
  const meta = status.checks.find((check) => check.key === "meta_marketing");
  assert.equal(meta.status, "error");
  assert.match(meta.summary, /ads_read and ad account access/);
});

test("R2 test objects are cleaned up after a later failure", async () => {
  const env = completeEnv();
  const deleted = [];
  const service = createSetupStatusService({
    env,
    repository: memoryRepository(),
    database: {
      async query(sql) {
        return /COUNT/.test(sql) ? { rows: [{ count: 1 }] } : { rows: [{ ok: 1 }] };
      },
    },
    ai: { async getReply() { return "ok"; } },
    storage: {
      async uploadMedia() { return "temporary-test-key"; },
      async deleteMedia(key) {
        deleted.push(key);
        if (deleted.length === 1) throw new Error("R2 delete rejected");
      },
    },
    fetchImpl: async (url) => {
      if (url.includes("api.telegram.org")) return response({ ok: true, result: {} });
      return response({ id: "ok", name: "ok" });
    },
  });

  const status = await service.runAll();
  const r2 = status.checks.find((item) => item.key === "r2");
  assert.equal(r2.status, "error");
  assert.equal(deleted.length, 2);
});

test("setup status route allows only administrators", () => {
  let nextCalled = false;
  requireAdministrator(
    { user: { role: "admin" } },
    {},
    () => { nextCalled = true; }
  );
  assert.equal(nextCalled, true);

  let statusCode = null;
  let responseBody = null;
  requireAdministrator(
    { user: { role: "sales" } },
    {
      status(code) { statusCode = code; return this; },
      json(body) { responseBody = body; return body; },
    },
    () => assert.fail("sales user must not reach setup status")
  );
  assert.equal(statusCode, 403);
  assert.match(responseBody.error, /administrators/);
});

test("error sanitization removes bearer and Telegram tokens", () => {
  const sanitized = safeError(
    new Error("Failed with Bearer abc123 and bot123456:telegram-token")
  );
  assert.equal(sanitized.includes("abc123"), false);
  assert.equal(sanitized.includes("telegram-token"), false);
});
