const test = require("node:test");
const assert = require("node:assert/strict");

const { createClientRegistryRepo } = require("../src/ops/clientRegistryRepo");

function row(overrides = {}) {
  return {
    client_slug: "acme",
    display_name: "Acme",
    base_url: "https://acme.example.com",
    industry: "home_renovation",
    purchased_channels: ["whatsapp"],
    token_env_key: "OPS_CLIENT_TOKEN_ACME",
    render_service_id: "srv-1",
    render_service_name: "acme",
    neon_project_id: "neon-1",
    neon_project_name: "acme",
    provisioned_commit_sha: "abc",
    ...overrides,
  };
}

test("registry insert stores only the token env key, not the token value", async () => {
  let captured;
  const repo = createClientRegistryRepo({
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [row()] };
    },
  });
  const client = {
    clientSlug: "acme",
    displayName: "Acme",
    baseUrl: "https://acme.example.com",
    industry: "home_renovation",
    purchasedChannels: ["whatsapp"],
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
    render: { serviceId: "srv-1", serviceName: "acme" },
    neon: { projectId: "neon-1", projectName: "acme" },
    provisionedCommitSha: "abc",
  };
  const saved = await repo.insertClient(client);

  assert.equal(saved.clientSlug, "acme");
  assert.match(captured.sql, /^INSERT INTO ops_clients/m);
  assert.doesNotMatch(captured.sql, /token_value|access_token|admin_password|database_url/i);
  assert.deepEqual(captured.params.includes("OPS_CLIENT_TOKEN_ACME"), true);
});

test("failed poll updates connectivity metadata without erasing the last readiness snapshot", async () => {
  let captured;
  const priorSnapshot = { readiness: { status: "ready" } };
  const repo = createClientRegistryRepo({
    query: async (sql, params) => {
      captured = { sql, params };
      return {
        rows: [row({
          last_poll_at: params?.[1],
          last_success_at: "2026-09-09T12:00:00.000Z",
          last_status: "ready",
          last_snapshot: priorSnapshot,
          last_error: params?.[3],
        })],
      };
    },
  });

  const saved = await repo.recordPollFailure("acme", {
    error: "timeout",
    polledAt: new Date("2026-09-09T12:05:00.000Z"),
  });

  assert.doesNotMatch(captured.sql, /last_snapshot\s*=|last_status\s*=/i);
  assert.deepEqual(saved.lastSnapshot, priorSnapshot);
  assert.equal(saved.lastStatus, "ready");
  assert.equal(saved.lastError, "timeout");
});
