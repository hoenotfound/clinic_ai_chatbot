const test = require("node:test");
const assert = require("node:assert/strict");

const mediaStorage = require("../src/services/mediaStorageService");
const { createSetupStatusService } = require("../src/services/setupStatusService");

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function runtimeEnv(overrides = {}) {
  return {
    CLIENT_SLUG: "///",
    AI_PROVIDER: "gemini",
    GEMINI_API_KEY: "gemini-key",
    SESSION_SECRET: "a-strong-random-session-secret-with-more-than-32-characters",
    PUBLIC_BASE_URL: "https://invalid-slug.example.test",
    WHATSAPP_PHONE_NUMBER_ID: "10001",
    WHATSAPP_TOKEN: "whatsapp-token",
    WHATSAPP_APP_SECRET: "whatsapp-app-secret",
    WHATSAPP_VERIFY_TOKEN: "whatsapp-verify-secret",
    R2_ACCOUNT_ID: "r2-account",
    R2_ACCESS_KEY_ID: "r2-access",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    R2_BUCKET_NAME: "private-media",
    ...overrides,
  };
}

function repository() {
  const rows = new Map([
    [
      "whatsapp_webhook",
      {
        check_key: "whatsapp_webhook",
        last_webhook_at: "2026-09-14T00:00:00.000Z",
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

test("configured but invalid CLIENT_SLUG fails media key creation closed", () => {
  const isolation = mediaStorage.getMediaIsolationStatus({ CLIENT_SLUG: "///" });

  assert.equal(isolation.mode, "legacy");
  assert.equal(isolation.prefix, null);
  assert.equal(isolation.reason, "invalid_client_slug");
  assert.throws(
    () => mediaStorage.buildMediaObjectKey({
      kind: "messages",
      contactId: 42,
      mimeType: "image/jpeg",
      now: 1,
      id: "fixed-id",
      env: { CLIENT_SLUG: "///" },
    }),
    (err) => {
      assert.equal(err.code, "INVALID_CLIENT_MEDIA_SLUG");
      assert.match(err.message, /CLIENT_SLUG is configured/i);
      return true;
    }
  );
});

test("Setup Status reports invalid CLIENT_SLUG as an R2 error", async () => {
  const env = runtimeEnv();
  let deleteCalled = false;
  const service = createSetupStatusService({
    env,
    repository: repository(),
    now: () => new Date("2026-09-14T01:00:00.000Z"),
    database: {
      async query(sql) {
        if (/COUNT/.test(sql)) return { rows: [{ count: 1 }] };
        return { rows: [{ ok: 1 }] };
      },
    },
    ai: {
      getGeminiApiKeys: () => [env.GEMINI_API_KEY],
      async getReply() {
        return "ok";
      },
    },
    storage: {
      async uploadMedia(buffer, mimeType, options) {
        assert.equal(buffer.toString(), "clinic-ai-setup-check");
        assert.equal(mimeType, "text/plain");
        assert.equal(options.contactId, "setup-check");
        assert.equal(options.env, env);
        return mediaStorage.buildMediaObjectKey({
          kind: "messages",
          contactId: options.contactId,
          mimeType,
          now: 1,
          id: "setup-check",
          env: options.env,
        });
      },
      async deleteMedia() {
        deleteCalled = true;
      },
    },
    fetchImpl: async (url) => {
      assert.match(String(url), /\/10001\?/);
      return response({ id: "10001", verified_name: "Invalid Slug Test" });
    },
  });

  const status = await service.runAll();
  const r2 = status.checks.find((item) => item.key === "r2");

  assert.equal(r2.status, "error");
  assert.equal(r2.reason, "invalid_client_slug");
  assert.equal(r2.mediaNamespace, null);
  assert.match(r2.summary, /CLIENT_SLUG is configured/i);
  assert.equal(deleteCalled, false);
});
