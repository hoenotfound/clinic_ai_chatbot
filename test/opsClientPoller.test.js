const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createClientPoller,
  normalizeRemoteSnapshot,
  normalizedBaseUrl,
  tokenFromEnv,
} = require("../src/ops/clientPoller");

function payload() {
  return {
    schemaVersion: 1,
    source: "da-chatbot",
    client: {
      slug: "acme",
      businessName: "Acme",
      businessType: "home_renovation",
    },
    deployment: {
      commitSha: "abc123",
      startedAt: "2026-09-09T11:00:00.000Z",
      appVersion: "0.1.0",
    },
    readiness: {
      status: "ready",
      ready: true,
      channels: [],
      blockers: [],
      testingRequired: [],
      warnings: [],
    },
  };
}

test("client polling refuses insecure non-local HTTP URLs", () => {
  assert.throws(() => normalizedBaseUrl("http://example.com"), /requires HTTPS/i);
  assert.equal(normalizedBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("registry token values stay in environment variables", () => {
  const client = { clientSlug: "acme", tokenEnvKey: "OPS_CLIENT_TOKEN_ACME" };
  assert.equal(
    tokenFromEnv(client, { OPS_CLIENT_TOKEN_ACME: "a".repeat(32) }),
    "a".repeat(32),
  );
  assert.throws(() => tokenFromEnv(client, {}), /missing or too short/i);
});

test("remote snapshot rejects a mismatched or missing registered client identity", () => {
  assert.throws(() => normalizeRemoteSnapshot(payload(), "other"), /identity mismatch/i);
  const withoutSlug = payload();
  delete withoutSlug.client.slug;
  assert.throws(() => normalizeRemoteSnapshot(withoutSlug, "acme"), /missing client slug/i);
});

test("poller sends bearer auth and returns a normalized snapshot", async () => {
  let request;
  const poller = createClientPoller({
    env: { OPS_CLIENT_TOKEN_ACME: "b".repeat(32) },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload()),
      };
    },
  });

  const result = await poller.pollClient({
    clientSlug: "acme",
    baseUrl: "https://acme.example.com/",
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
  });

  assert.equal(request.url, "https://acme.example.com/api/ops/readiness");
  assert.equal(request.options.headers.authorization, `Bearer ${"b".repeat(32)}`);
  assert.equal(result.snapshot.readiness.status, "ready");
  assert.equal(result.snapshot.deployment.appVersion, "0.1.0");
});

test("poll timeout is classified as an unreachable client condition", async () => {
  const poller = createClientPoller({
    env: { OPS_CLIENT_TOKEN_ACME: "b".repeat(32) },
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });

  await assert.rejects(
    poller.pollClient({
      clientSlug: "acme",
      baseUrl: "https://acme.example.com",
      tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
    }),
    (error) => error.code === "OPS_POLL_TIMEOUT" && /timed out/i.test(error.message),
  );
});

test("parent abort cancels a client readiness request without classifying it as a timeout", async () => {
  const controller = new AbortController();
  const poller = createClientPoller({
    env: { OPS_CLIENT_TOKEN_ACME: "b".repeat(32) },
    timeoutMs: 1000,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });

  const request = poller.pollClient({
    clientSlug: "acme",
    baseUrl: "https://acme.example.com",
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
  }, { signal: controller.signal });
  controller.abort();

  await assert.rejects(
    request,
    (error) => error.code === "OPS_POLL_CANCELLED" && /cancelled/i.test(error.message),
  );
});
