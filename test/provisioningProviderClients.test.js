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

test("Render create request uses Node service contract plus the existing root health check", async () => {
  let sent;
  const client = createRenderClient({
    apiKey: "render-key",
    ownerId: "owner-1",
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) };
      return response(201, {
        service: { id: "srv-1", name: "da-chatbot-acme" },
        deployId: "dep-1",
      });
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
    healthCheckPath: "/",
  });

  assert.equal(sent.options.method, "POST");
  assert.equal(sent.body.type, "web_service");
  assert.equal(sent.body.autoDeploy, "yes");
  assert.equal(sent.body.serviceDetails.runtime, "node");
  assert.equal(sent.body.serviceDetails.region, "singapore");
  assert.equal(sent.body.serviceDetails.plan, "starter");
  assert.equal(sent.body.serviceDetails.healthCheckPath, "/");
  assert.deepEqual(sent.body.serviceDetails.envSpecificDetails, {
    buildCommand: "npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build",
    startCommand: "npm start",
  });
});

test("Render deploy waiter polls until the initial deploy is live", async () => {
  let calls = 0;
  const client = createRenderClient({
    apiKey: "render-key",
    ownerId: "owner-1",
    deployPollMs: 0,
    sleep: async () => {},
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url.pathname, "/v1/services/srv-1/deploys/dep-1");
      return response(200, {
        id: "dep-1",
        status: calls === 1 ? "build_in_progress" : "live",
      });
    },
  });

  const deploy = await client.waitForDeploy("srv-1", "dep-1");
  assert.equal(deploy.status, "live");
  assert.equal(calls, 2);
});

test("Render deploy waiter fails closed on a terminal failed deploy", async () => {
  const client = createRenderClient({
    apiKey: "render-key",
    ownerId: "owner-1",
    fetchImpl: async () => response(200, {
      id: "dep-1",
      status: "build_failed",
    }),
  });

  await assert.rejects(
    client.waitForDeploy("srv-1", "dep-1"),
    (err) => err instanceof ProviderApiError && err.resourceStatus === "build_failed"
  );
});

test("Neon project preflight paginates search results and filters exact names locally", async () => {
  const requestUrls = [];
  const client = createNeonClient({
    apiKey: "neon-key",
    orgId: "org-1",
    fetchImpl: async (url) => {
      requestUrls.push(url);
      if (requestUrls.length === 1) {
        return response(200, {
          projects: [{ id: "p2", name: "da-chatbot-acme-old" }],
          pagination: { cursor: "next-page" },
          unavailable: [],
        });
      }
      return response(200, {
        projects: [{ id: "p1", name: "da-chatbot-acme" }],
        unavailable: [],
      });
    },
  });

  const matches = await client.findProjectsByExactName("da-chatbot-acme");
  assert.deepEqual(matches.map((project) => project.id), ["p1"]);
  assert.equal(requestUrls.length, 2);
  assert.equal(requestUrls[0].searchParams.get("limit"), "400");
  assert.equal(requestUrls[0].searchParams.get("search"), "da-chatbot-acme");
  assert.equal(requestUrls[0].searchParams.get("org_id"), "org-1");
  assert.equal(requestUrls[1].searchParams.get("cursor"), "next-page");
});

test("Neon project preflight rejects incomplete unavailable search results", async () => {
  const client = createNeonClient({
    apiKey: "neon-key",
    fetchImpl: async () => response(200, {
      projects: [],
      unavailable: [{ project_id: "unknown-project" }],
    }),
  });

  await assert.rejects(
    client.findProjectsByExactName("da-chatbot-acme"),
    (err) => err instanceof ProviderApiError && /incomplete results/.test(err.message)
  );
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

test("provider errors redact client runtime values and database credentials", async () => {
  const client = createRenderClient({
    apiKey: "render-control-key",
    ownerId: "owner-1",
    fetchImpl: async () => response(400, {
      message: "invalid env gemini-secret with postgresql://dbuser:dbpassword@example.invalid/db and render-control-key",
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
      envVars: [
        { key: "GEMINI_API_KEY", value: "gemini-secret" },
        { key: "DATABASE_URL", value: "postgresql://dbuser:dbpassword@example.invalid/db" },
      ],
    }),
    (err) => {
      assert.equal(err.message.includes("gemini-secret"), false);
      assert.equal(err.message.includes("dbpassword"), false);
      assert.equal(err.message.includes("render-control-key"), false);
      assert.equal(err.message.includes("[REDACTED]"), true);
      return true;
    }
  );
});
