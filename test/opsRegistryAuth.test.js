const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRequireOpsAdmin,
  parseBasicAuth,
} = require("../src/ops/requireOpsAdmin");
const { createOpsRegistryApp } = require("../src/ops/server");
const { clientDetailHtml } = require("../src/ops/dashboard");

test("basic auth parser preserves colons in the password", () => {
  const header = `Basic ${Buffer.from("admin:pass:word").toString("base64")}`;
  assert.deepEqual(parseBasicAuth(header), { username: "admin", password: "pass:word" });
});

test("client detail page safely embeds an untrusted route slug", () => {
  const html = clientDetailHtml('</script><script>alert("xss")</script>');
  assert.equal(html.includes('</script><script>alert("xss")</script>'), false);
  assert.match(html, /const clientSlug = "\\u003c\/script\\u003e/);
});

async function withServer(callback) {
  const fleetService = {
    listFleet: async () => ({ schemaVersion: 1, summary: { total: 1 }, clients: [{ clientSlug: "acme" }] }),
    getClient: async (slug) => slug === "acme"
      ? {
          clientSlug: "acme",
          displayName: "Acme",
          status: "ready",
          tokenConfigured: true,
          readiness: { status: "ready" },
        }
      : null,
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

test("registry health is public but fleet and detail data require operations admin auth", async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/clients`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/clients/acme`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/refresh-all`, { method: "POST" })).status, 401);

    const authorization = `Basic ${Buffer.from("ops:long-enough-password").toString("base64")}`;
    const response = await fetch(`${baseUrl}/api/clients`, {
      headers: { authorization },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schemaVersion, 1);

    const detail = await fetch(`${baseUrl}/api/clients/acme`, { headers: { authorization } });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.clientSlug, "acme");
    assert.equal(Object.hasOwn(body, "token"), false);
    assert.equal(Object.hasOwn(body, "tokenEnvKey"), false);
    assert.equal(Object.hasOwn(body, "databaseUrl"), false);
  });
});

test("unknown protected client detail returns 404", async () => {
  await withServer(async (baseUrl) => {
    const authorization = `Basic ${Buffer.from("ops:long-enough-password").toString("base64")}`;
    const response = await fetch(`${baseUrl}/api/clients/missing`, { headers: { authorization } });
    assert.equal(response.status, 404);
  });
});
