const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createClientRegistryRepo,
  rowToClient,
} = require("../src/ops/clientRegistryRepo");

test("legacy rows without lifecycle present as live while migrated/new rows use their stored value", () => {
  assert.equal(rowToClient({ lifecycle_status: undefined }).lifecycleStatus, "live");
  assert.equal(rowToClient({ lifecycle_status: "setup" }).lifecycleStatus, "setup");
  assert.equal(rowToClient({ lifecycle_status: "trial" }).lifecycleStatus, "trial");
});

test("upsert without lifecycle preserves an existing lifecycle instead of resetting a live client", async () => {
  const calls = [];
  const repo = createClientRegistryRepo({
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return {
        rows: [{
          client_slug: "acme",
          display_name: "Acme",
          base_url: "https://acme.example.com",
          purchased_channels: [],
          token_env_key: "OPS_CLIENT_TOKEN_ACME",
          lifecycle_status: "live",
        }],
      };
    },
  });

  const saved = await repo.upsertClient({
    clientSlug: "acme",
    displayName: "Acme",
    baseUrl: "https://acme.example.com",
    purchasedChannels: [],
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
  });

  assert.equal(saved.lifecycleStatus, "live");
  assert.equal(calls[0].params[11], null);
  assert.match(calls[0].sql, /lifecycle_status = COALESCE\(\$12::text, ops_clients\.lifecycle_status\)/i);
});

test("explicit lifecycle values are validated before repository writes", async () => {
  let calls = 0;
  const repo = createClientRegistryRepo({
    query: async () => {
      calls += 1;
      return { rows: [] };
    },
  });

  await assert.rejects(
    repo.updateLifecycle("acme", "production"),
    (error) => error?.code === "OPS_CLIENT_LIFECYCLE_INVALID",
  );
  assert.equal(calls, 0);
});
