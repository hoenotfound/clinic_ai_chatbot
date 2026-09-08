const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ProviderApiError,
  createNeonClient,
  createRenderClient,
} = require("../src/provisioning/providerClients");

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined || payload === null ? "" : JSON.stringify(payload);
    },
  };
}

test("Render preflight uses exact workspace/name filtering", async () => {
  let requestUrl;
  const client = createRenderClient({
    apiKey: "render-key",
    ownerId: "owner-1",
    fetchImpl: async (url) => {
      requestUrl = url;
      return response(200, [
        { service: { id: "1", name: "da-chatbot-acme", ownerId: "owner-1" } },
        { service: { id: "2", name: "da-chatbot-acme-copy", ownerId: "owner-1" } },
      ]);
    },
  });

  const matches = await client.findServicesByExactName("da-chatbot-acme");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "1");
  assert.equal(requestUrl.pathname, "/v1/services");
  assert.equal(requestUrl.searchParams.get("name"), "da-chatbot-acme");
  assert.equal(requestUrl.searchParams.get("ownerId"), "owner-1");
});

test("Render create request uses the current native Node serviceDetails contract", async () => {
  let sent;
  const client = createRenderClient({
    apiKey: "render-key",
    ownerId: "owner-1",
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) };
      return response(201, { service: { id: "srv-1", name: "da-chatbot-acme" }, deployId: "dep-1" });
    },
  });

  await client.createWebService({
    name: "da-chatbot-acme",
    repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
    branch: "main",
    region: "singapore",
    plan: "starter",
    buildCommand: "npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build",
    startCommand: "npm start",
    envVars: [{ key: "INITIAL_BUSINESS_TYPE", value: "generic" }],
  });

  assert.equal(sent.options.method, "POST");
  assert.equal(sent.body.type, "web_service");
  assert.equal(sent.body.autoDeploy, "yes");
  assert.equal(sent.body.serviceDetails.runtime, "node");
  assert.equal(sent.body.serviceDetails.region, "singapore");
  assert.equal(sent.body.serviceDetails.plan, "starter");
  assert.deepEqual(sent.body.serviceDetails.envSpecificDetails, {
    buildCommand: "npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build",
    startCommand: "npm start",
  });
  assert.deepEqual(sent.body.envVars, [{ key: "INITIAL_BUSINESS_TYPE", value: "generic" }]);
});

test("Neon project preflight uses search but still filters exact names locally", async () => {
  let requestUrl;
  const client = createNeonClient({
    apiKey: "neon-key",
    orgId: "org-1",
    fetchImpl: async (url) => {
      requestUrl = url;
      return response(200, {
        projects: [
          { id: "p1", name: "da-chatbot-acme" },
          { id: "p2", name: "da-chatbot-acme-old" },
        ],
      });
    },
  });

  const matches = await client.findProjectsByExactName("da-chatbot-acme");
  assert.deepEqual(matches.map((project) => project.id), ["p1"]);
  assert.equal(requestUrl.searchParams.get("search"), "da-chatbot-acme");
  assert.equal(requestUrl.searchParams.get("org_id"), "org-1");
});

test("Neon create request carries project name/region and org scope", async () => {
  let sent;
  const client = createNeonClient({
    apiKey: "neon-key",
    orgId: "org-1",
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) };
      return response(201, {
        project: { id: "p1", name: "da-chatbot-acme" },
        databases: [{ name: "neondb" }],
        roles: [{ name: "neondb_owner" }],
        operations: [],
      });
    },
  });

  await client.createProject({ name: "da-chatbot-acme", regionId: "aws-ap-southeast-1" });
  assert.equal(sent.options.method, "POST");
  assert.equal(sent.url.searchParams.get("org_id"), "org-1");
  assert.deepEqual(sent.body, {
    project: {
      name: "da-chatbot-acme",
      region_id: "aws-ap-southeast-1",
    },
  });
});

test("Neon connection URI request explicitly asks for pooled=true", async () => {
  let requestUrl;
  const client = createNeonClient({
    apiKey: "neon-key",
    fetchImpl: async (url) => {
      requestUrl = url;
      return response(200, { uri: "postgresql://user:secret@host-pooler/neondb" });
    },
  });

  const uri = await client.getPooledConnectionUri({
    projectId: "p1",
    databaseName: "neondb",
    roleName: "neondb_owner",
  });
  assert.equal(uri.includes("pooler"), true);
  assert.equal(requestUrl.searchParams.get("pooled"), "true");
  assert.equal(requestUrl.searchParams.get("database_name"), "neondb");
  assert.equal(requestUrl.searchParams.get("role_name"), "neondb_owner");
});

test("Neon operation waiter does not use the database until create operations finish", async () => {
  let calls = 0;
  const client = createNeonClient({
    apiKey: "neon-key",
    operationPollMs: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return response(200, {
        operation: {
          id: "op-1",
          status: calls === 1 ? "running" : "finished",
        },
      });
    },
  });

  await client.waitForOperations("p1", [{ id: "op-1" }]);
  assert.equal(calls, 2);
});

test("non-idempotent provider network failures are marked ambiguous and never auto-retried", async () => {
  let calls = 0;
  const client = createNeonClient({
    apiKey: "neon-key",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("socket closed");
    },
  });

  await assert.rejects(
    client.createProject({ name: "da-chatbot-acme", regionId: "aws-ap-southeast-1" }),
    (err) => err instanceof ProviderApiError && err.ambiguous === true && err.method === "POST"
  );
  assert.equal(calls, 1);
});

test("provider error text does not echo arbitrary response bodies", async () => {
  const client = createRenderClient({
    apiKey: "render-key",
    ownerId: "owner-1",
    fetchImpl: async () => response(400, {
      message: "invalid service configuration",
      debug: "postgresql://secret:password@example.invalid/db",
    }),
  });

  await assert.rejects(
    client.createWebService({
      name: "bad",
      repo: "repo",
      branch: "main",
      region: "singapore",
      plan: "starter",
      buildCommand: "npm ci",
      startCommand: "npm start",
      envVars: [],
    }),
    (err) => err.message.includes("invalid service configuration") && !err.message.includes("password")
  );
});
