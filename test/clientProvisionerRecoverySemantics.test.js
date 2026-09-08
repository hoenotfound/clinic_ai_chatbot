const test = require("node:test");
const assert = require("node:assert/strict");

const {
  provisionClient,
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
    async waitForDeploy(serviceId, deployId) {
      calls.push(["render.wait", serviceId, deployId]);
      return { id: deployId, status: "live" };
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

function execute(clients, input = {}) {
  return provisionClient({
    clientSlug: "client-one",
    industry: "generic",
    ...input,
  }, {
    execute: true,
    env: EXEC_ENV,
    renderClient: clients.renderClient,
    neonClient: clients.neonClient,
  });
}

test("Neon create receives the selected region through the provider client's regionId contract", async () => {
  const clients = fakeClients();
  await execute(clients, { neonRegion: "aws-ap-southeast-1" });

  const createCall = clients.calls.find(([name]) => name === "neon.create");
  assert.ok(createCall);
  assert.deepEqual(createCall[1], {
    name: "da-chatbot-client-one",
    regionId: "aws-ap-southeast-1",
  });
  assert.equal(Object.hasOwn(createCall[1], "region"), false);
});

test("ambiguous Neon create failures are never marked safe to retry blindly", async () => {
  const clients = fakeClients({
    neonClient: {
      async createProject() {
        const err = new Error("network request failed");
        err.ambiguous = true;
        throw err;
      },
    },
  });

  await assert.rejects(
    execute(clients),
    (err) => {
      assert.equal(err.code, "NEON_CREATE_FAILED");
      assert.equal(err.stage, "neon_create");
      assert.equal(err.retrySafe, false);
      assert.match(err.message, /non-idempotent/i);
      return true;
    }
  );
  assert.equal(clients.calls.some(([name]) => name === "render.create"), false);
});

test("provider failure during collision preflight is structured and creates no resources", async () => {
  const clients = fakeClients({
    renderClient: {
      async findServicesByExactName() {
        throw new Error("Render lookup unavailable");
      },
    },
  });

  await assert.rejects(
    execute(clients),
    (err) => {
      assert.equal(err.code, "COLLISION_CHECK_FAILED");
      assert.equal(err.stage, "preflight");
      assert.equal(err.retrySafe, true);
      return true;
    }
  );
  assert.equal(clients.calls.some(([name]) => name === "neon.create"), false);
  assert.equal(clients.calls.some(([name]) => name === "render.create"), false);
});

test("an exact preflight collision remains fail-closed and is not a blind retry", async () => {
  const clients = fakeClients({
    neonClient: {
      async findProjectsByExactName(name) {
        clients.calls.push(["neon.find", name]);
        return [{ id: "existing", name }];
      },
    },
  });

  await assert.rejects(
    execute(clients),
    (err) => {
      assert.equal(err.code, "RESOURCE_NAME_COLLISION");
      assert.equal(err.stage, "preflight");
      assert.equal(err.retrySafe, false);
      return true;
    }
  );
  assert.equal(clients.calls.some(([name]) => name === "neon.create"), false);
});

test("Neon operation failure preserves the created project with the dedicated recovery code", async () => {
  const clients = fakeClients({
    neonClient: {
      async waitForOperations() {
        throw new Error("operation failed");
      },
    },
  });

  await assert.rejects(
    execute(clients),
    (err) => {
      assert.equal(err.code, "NEON_NOT_READY");
      assert.equal(err.stage, "neon_created");
      assert.equal(err.retrySafe, true);
      assert.deepEqual(err.partialResources, {
        neonProjectId: "neon-project-123",
        neonProjectName: "da-chatbot-client-one",
      });
      return true;
    }
  );
});

test("Neon connection URI failure preserves the created project with a distinct recovery code", async () => {
  const clients = fakeClients({
    neonClient: {
      async getPooledConnectionUri() {
        throw new Error("connection URI unavailable");
      },
    },
  });

  await assert.rejects(
    execute(clients),
    (err) => {
      assert.equal(err.code, "NEON_CONNECTION_URI_FAILED");
      assert.equal(err.stage, "neon_created");
      assert.equal(err.retrySafe, true);
      assert.equal(err.partialResources.neonProjectId, "neon-project-123");
      return true;
    }
  );
});
