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
    deployment: { commitSha: "abc123" },
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
    "a".repeat(32)
  );
  assert.throws(() => tokenFromEnv(client, {}), /missing or too short/i);
});

test("remote snapshot rejects a mismatched client identity", () => {
  assert.throws(() => normalizeRemoteSnapshot(payload(), "other"), /identity mismatch/i);
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
});
