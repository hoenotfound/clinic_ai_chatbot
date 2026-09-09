const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRequireOpsAdmin,
  parseBasicAuth,
} = require("../src/ops/requireOpsAdmin");
const { createOpsRegistryApp } = require("../src/ops/server");

test("basic auth parser preserves colons in the password", () => {
  const header = `Basic ${Buffer.from("admin:pass:word").toString("base64")}`;
  assert.deepEqual(parseBasicAuth(header), { username: "admin", password: "pass:word" });
});

async function withServer(callback) {
  const fleetService = {
    listFleet: async () => ({ schemaVersion: 1, summary: { total: 0 }, clients: [] }),
    refreshAll: async () => ({ schemaVersion: 1, clients: [] }),
    refreshClient: async () => ({ clientSlug: "acme" }),
  };
  const app = createOpsRegistryApp({
    fleetService,
    authenticate: createRequireOpsAdmin({
      env: {
        OPS_REGISTRY_ADMIN_USERNAME: "ops",
        OPS_REGISTRY_ADMIN_PASSWORD: "long-enough-password",
      },
    }),
    healthCheck: async () => true,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("registry health is public but fleet data requires operations admin auth", async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/clients`)).status, 401);

    const authorization = `Basic ${Buffer.from("ops:long-enough-password").toString("base64")}`;
    const response = await fetch(`${baseUrl}/api/clients`, {
      headers: { authorization },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schemaVersion, 1);
  });
});
