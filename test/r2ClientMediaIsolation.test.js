const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSetupStatusService,
  definitions,
} = require("../src/services/setupStatusService");

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function env(overrides = {}) {
  return {
    CLIENT_SLUG: "acme-renovation",
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-key",
    SESSION_SECRET: "a-strong-random-session-secret-with-more-than-32-characters",
    PUBLIC_BASE_URL: "https://acme.example.test",
    WHATSAPP_PHONE_NUMBER_ID: "10001",
    WHATSAPP_TOKEN: "whatsapp-token",
    WHATSAPP_APP_SECRET: "whatsapp-app-secret",
    WHATSAPP_VERIFY_TOKEN: "whatsapp-verify-secret",
    R2_ACCOUNT_ID: "r2-account",
    R2_ACCESS_KEY_ID: "r2-access",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    R2_BUCKET_NAME: "acme-private-media",
    ...overrides,
  };
}

function repository() {
  const rows = new Map([
    [
      "whatsapp_webhook",
      {
        check_key: "whatsapp_webhook",
        last_webhook_at: "2026-09-12T01:00:00.000Z",
      },
    ],
  ]);
  return {
    async listConnectionHealth() {
      return [...rows.values()];
    },
    async listLatestInboundActivity() {
      return [];
    },
    async listAiCandidateHealth() {
      return [];
    },
    async saveCheckResults(results) {
      for (const item of results) {
        rows.set(item.key, {
          check_key: item.key,
          last_check_status: item.status,
          last_check_summary: item.summary,
          last_checked_at: item.checkedAt,
          last_success_at: item.status === "ready" ? item.checkedAt : null,
        });
      }
    },
  };
}

test("Setup Status exposes the active client media namespace", () => {
  const r2 = definitions(env()).find((item) => item.key === "r2");

  assert.equal(r2.isConfigured, true);
  assert.equal(r2.meta.isolationMode, "isolated");
  assert.equal(r2.meta.mediaNamespace, "clients/acme-renovation");
  assert.equal(r2.meta.isolationReason, null);
});

test("Setup Status verifies its R2 test object is written under the client namespace", async () => {
  const runtimeEnv = env();
  const deleted = [];
  const service = createSetupStatusService({
    env: runtimeEnv,
    repository: repository(),
    now: () => new Date("2026-09-12T02:00:00.000Z"),
    database: {
      async query(sql) {
        if (/COUNT/.test(sql)) return { rows: [{ count: 1 }] };
        return { rows: [{ ok: 1 }] };
      },
    },
    ai: {
      getGeminiApiKeys: () => [runtimeEnv.GEMINI_API_KEY],
      async getReply() {
        return "ok";
      },
    },
    storage: {
      async uploadMedia(buffer, mimeType, options) {
        assert.equal(buffer.toString(), "clinic-ai-setup-check");
        assert.equal(mimeType, "text/plain");
        assert.equal(options.contactId, "setup-check");
        assert.equal(options.env, runtimeEnv);
        return "clients/acme-renovation/messages/setup-check/object.bin";
      },
      async deleteMedia(key) {
        deleted.push(key);
      },
    },
    fetchImpl: async (url) => {
      assert.match(String(url), /\/10001\?/);
      return response({ id: "10001", verified_name: "Acme WhatsApp" });
    },
  });

  const status = await service.runAll();
  const r2 = status.checks.find((item) => item.key === "r2");

  assert.equal(r2.status, "ready");
  assert.equal(r2.isolationMode, "isolated");
  assert.equal(r2.mediaNamespace, "clients/acme-renovation");
  assert.match(r2.summary, /clients\/acme-renovation\//);
  assert.deepEqual(deleted, ["clients/acme-renovation/messages/setup-check/object.bin"]);
});

test("legacy deployments remain usable but expose legacy namespace mode", () => {
  const r2 = definitions(env({ CLIENT_SLUG: "" })).find((item) => item.key === "r2");

  assert.equal(r2.isConfigured, true);
  assert.equal(r2.meta.isolationMode, "legacy");
  assert.equal(r2.meta.mediaNamespace, null);
  assert.equal(r2.meta.isolationReason, "client_slug_missing");
});
