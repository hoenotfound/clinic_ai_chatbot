const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ClientProvisioningError,
  buildProvisioningPlan,
  provisionClient,
  renderEnvVars,
} = require("../src/provisioning/clientProvisioner");

const EXEC_ENV = {
  PROVISIONING_RENDER_API_KEY: "render-control-key",
  PROVISIONING_RENDER_OWNER_ID: "tea-owner",
  PROVISIONING_NEON_API_KEY: "neon-control-key",
  PROVISIONING_RENDER_PLAN: "starter",
};

function fakeClients(overrides = {}) {
  const calls = [];
  const renderClient = {
    async findServicesByExactName(name) {
      calls.push(["render.find", name]);
      return [];
    },
    async createWebService(payload) {
      calls.push(["render.create", payload]);
      return {
        service: {
          id: "srv-123",
          name: payload.name,
          serviceDetails: { url: `https://${payload.name}.onrender.com` },
        },
        deployId: "dep-123",
      };
    },
    ...overrides.renderClient,
  };
  const neonClient = {
    async findProjectsByExactName(name) {
      calls.push(["neon.find", name]);
      return [];
    },
    async createProject(payload) {
      calls.push(["neon.create", payload]);
      return {
        project: { id: "neon-project-123", name: payload.name },
        databases: [{ name: "neondb" }],
        roles: [{ name: "neondb_owner" }],
        operations: [{ id: "operation-1" }],
      };
    },
    async waitForOperations(projectId, operations) {
      calls.push(["neon.wait", projectId, operations]);
    },
    async getPooledConnectionUri(payload) {
      calls.push(["neon.uri", payload]);
      return "postgresql://user:secret@host-pooler.example/neondb?sslmode=require";
    },
    ...overrides.neonClient,
  };
  return { calls, renderClient, neonClient };
}

test("provisioning requires an explicit industry instead of silently defaulting to clinic", () => {
  assert.throws(
    () => buildProvisioningPlan({ clientSlug: "client-one" }, {}),
    (err) => err instanceof ClientProvisioningError && err.code === "INDUSTRY_REQUIRED"
  );
});

test("industry aliases normalize to the canonical profile contract", () => {
  const plan = buildProvisioningPlan({
    clientSlug: "Acme Cabinets",
    industry: "renovation",
  }, {});

  assert.equal(plan.clientSlug, "acme-cabinets");
  assert.equal(plan.industry, "home_renovation");
  assert.equal(plan.resourceName, "da-chatbot-acme-cabinets");
});

test("unsupported industry fails before any provider work", async () => {
  const clients = fakeClients();
  await assert.rejects(
    provisionClient({ clientSlug: "client-one", industry: "restaurant" }, {
      execute: true,
      env: EXEC_ENV,
      renderClient: clients.renderClient,
      neonClient: clients.neonClient,
    }),
    (err) => err.code === "INDUSTRY_UNSUPPORTED"
  );
  assert.deepEqual(clients.calls, []);
});

test("runtime env cannot override app or control-plane provisioning values", () => {
  for (const key of [
    "INITIAL_BUSINESS_TYPE",
    "BUSINESS_TYPE",
    "DATABASE_URL",
    "SESSION_SECRET",
    "PORT",
    "PROVISIONING_NEON_API_KEY",
    "PROVISIONING_FUTURE_CONTROL",
  ]) {
    assert.throws(
      () => buildProvisioningPlan({
        clientSlug: "client-one",
        industry: "generic",
        runtimeEnv: { [key]: "unsafe" },
      }, {}),
      (err) => err.code === "RUNTIME_ENV_RESERVED"
    );
  }
});

test("dry run makes no provider calls and does not require cloud credentials", async () => {
  const result = await provisionClient({
    clientSlug: "cabinet-pro",
    industry: "home_renovation",
    runtimeEnv: { GEMINI_API_KEY: "do-not-print-this" },
  }, { execute: false, env: {} });

  assert.equal(result.mode, "plan");
  assert.equal(result.plan.industry, "home_renovation");
  assert.deepEqual(result.plan.render.runtimeEnvKeys, ["GEMINI_API_KEY"]);
  assert.equal(JSON.stringify(result).includes("do-not-print-this"), false);
});

test("execution requires an explicit Render plan to avoid accidental billing choices", async () => {
  const clients = fakeClients();
  const env = { ...EXEC_ENV };
  delete env.PROVISIONING_RENDER_PLAN;

  await assert.rejects(
    provisionClient({ clientSlug: "client-one", industry: "generic" }, {
      execute: true,
      env,
      renderClient: clients.renderClient,
      neonClient: clients.neonClient,
    }),
    (err) => err.code === "PROVISIONING_CONFIG_MISSING" && /RENDER_PLAN/.test(err.message)
  );
  assert.deepEqual(clients.calls, []);
});

test("preflight name collision stops before either cloud resource is created", async () => {
  const clients = fakeClients({
    renderClient: {
      async findServicesByExactName(name) {
        clients.calls.push(["render.find", name]);
        return [{ id: "srv-existing", name }];
      },
    },
  });

  await assert.rejects(
    provisionClient({ clientSlug: "client-one", industry: "aesthetic_clinic" }, {
      execute: true,
      env: EXEC_ENV,
      renderClient: clients.renderClient,
      neonClient: clients.neonClient,
    }),
    (err) => err.code === "RESOURCE_NAME_COLLISION" && err.stage === "preflight"
  );

  assert.equal(clients.calls.some(([name]) => name === "neon.create"), false);
  assert.equal(clients.calls.some(([name]) => name === "render.create"), false);
});

test("successful provisioning wires the pooled Neon URL and exact industry into Render", async () => {
  const clients = fakeClients();
  const result = await provisionClient({
    clientSlug: "reno-alpha",
    industry: "cabinetry",
    runtimeEnv: {
      GEMINI_API_KEY: "gemini-secret",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "admin-secret",
    },
  }, {
    execute: true,
    env: EXEC_ENV,
    renderClient: clients.renderClient,
    neonClient: clients.neonClient,
  });

  assert.equal(result.mode, "executed");
  assert.equal(result.industry, "home_renovation");
  assert.equal(result.profileContract.value, "home_renovation");

  const renderCreate = clients.calls.find(([name]) => name === "render.create")[1];
  const byKey = new Map(renderCreate.envVars.map((entry) => [entry.key, entry]));
  assert.deepEqual(byKey.get("INITIAL_BUSINESS_TYPE"), {
    key: "INITIAL_BUSINESS_TYPE",
    value: "home_renovation",
  });
  assert.equal(byKey.get("DATABASE_URL").value.includes("-pooler.example"), true);
  assert.deepEqual(byKey.get("SESSION_SECRET"), { key: "SESSION_SECRET", generateValue: true });
  assert.equal(byKey.get("GEMINI_API_KEY").value, "gemini-secret");

  const publicResult = JSON.stringify(result);
  assert.equal(publicResult.includes("gemini-secret"), false);
  assert.equal(publicResult.includes("admin-secret"), false);
  assert.equal(publicResult.includes("postgresql://"), false);
});

test("Render failure preserves and reports the already-created Neon project", async () => {
  const clients = fakeClients({
    renderClient: {
      async createWebService(payload) {
        clients.calls.push(["render.create", payload]);
        throw new Error("Render rejected service configuration");
      },
    },
  });

  await assert.rejects(
    provisionClient({ clientSlug: "client-one", industry: "generic" }, {
      execute: true,
      env: EXEC_ENV,
      renderClient: clients.renderClient,
      neonClient: clients.neonClient,
    }),
    (err) => {
      assert.equal(err.code, "RENDER_CREATE_FAILED");
      assert.equal(err.retrySafe, false);
      assert.deepEqual(err.partialResources, {
        neonProjectId: "neon-project-123",
        neonProjectName: "da-chatbot-client-one",
      });
      return true;
    }
  );
});

test("renderEnvVars keeps provisioner-owned values ahead of custom runtime env", () => {
  const plan = buildProvisioningPlan({
    clientSlug: "client-one",
    industry: "aesthetic",
    runtimeEnv: { AI_PROVIDER: "gemini" },
  }, {});
  const envVars = renderEnvVars(plan, "postgresql://pooled");
  assert.deepEqual(envVars.slice(0, 3), [
    { key: "INITIAL_BUSINESS_TYPE", value: "aesthetic_clinic" },
    { key: "DATABASE_URL", value: "postgresql://pooled" },
    { key: "SESSION_SECRET", generateValue: true },
  ]);
});
