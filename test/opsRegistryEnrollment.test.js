const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOpsEnrollmentPlan,
  defaultTokenEnvKey,
  deployPreparedClientToken,
  deployPreparedRegistryToken,
  generateOpsReadinessToken,
  markPreparedClientDeployment,
  opsEnrollmentFailureState,
  prepareOpsRegistryEnrollment,
  requireOpsEnrollmentConfig,
  verifyAndRegisterPreparedEnrollment,
  withOpsRepo,
} = require("../src/provisioning/opsRegistryEnrollment");

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload == null ? "" : JSON.stringify(payload);
    },
  };
}

const BASE_ENV = {
  PROVISIONING_RENDER_API_KEY: "render-control-key",
  PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID: "srv-registry",
  OPS_DATABASE_URL: "postgresql://ops:secret@localhost:5432/ops",
};

function resultFixture() {
  return {
    mode: "executed",
    clientSlug: "acme-clinic",
    industry: "aesthetic_clinic",
    requiredChannels: ["whatsapp", "instagram"],
    render: {
      serviceId: "srv-client",
      serviceName: "da-chatbot-acme-clinic",
      url: "https://client.example",
      deployedCommitSha: "commit-123",
    },
    neon: {
      projectId: "neon-123",
      projectName: "da-chatbot-acme-clinic",
    },
  };
}

function readinessPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    source: "da-chatbot",
    client: {
      slug: "acme-clinic",
      businessName: "Acme Clinic",
      businessType: "aesthetic_clinic",
      ...(overrides.client || {}),
    },
    deployment: {
      commitSha: "commit-123",
      startedAt: "2026-09-10T12:00:00.000Z",
      appVersion: "0.1.0",
      ...(overrides.deployment || {}),
    },
    readiness: {
      status: "ready",
      ready: true,
      checkedAt: "2026-09-10T12:01:00.000Z",
      channelContract: {
        configured: true,
        channels: ["whatsapp", "instagram"],
        error: null,
      },
      channels: [],
      blockers: [],
      testingRequired: [],
      warnings: [],
      ...(overrides.readiness || {}),
    },
  };
}

function makeRenderFetch({ payload = readinessPayload(), calls = [] } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ host: parsed.host, pathname: parsed.pathname, method, body });

    if (parsed.host === "api.render.com") {
      if (method === "PUT" && parsed.pathname.includes("/env-vars/")) {
        return response(200, {});
      }
      if (method === "POST" && parsed.pathname.endsWith("/deploys")) {
        const serviceId = parsed.pathname.split("/")[3];
        return response(201, { id: `dep-${serviceId}`, status: "queued" });
      }
    }
    if (parsed.host === "client.example" && parsed.pathname === "/api/ops/readiness") {
      return response(200, payload);
    }
    throw new Error(`Unexpected request ${method} ${parsed.toString()}`);
  };
}

function fakeRenderClient() {
  return {
    async waitForDeploy(_serviceId, deployId) {
      return { id: deployId, status: "live" };
    },
  };
}

function fakeRegistryStorage() {
  const calls = [];
  const repo = {
    async upsertClient(record) {
      calls.push(["upsert", record]);
      return record;
    },
    async recordPollSuccess(clientSlug, detail) {
      calls.push(["success", clientSlug, detail]);
      return null;
    },
  };
  return {
    calls,
    createPool: () => ({
      async end() {
        calls.push(["pool.end"]);
      },
    }),
    migrate: async () => calls.push(["migrate"]),
    createRepo: () => repo,
  };
}

async function preparedForVerification({
  payload = readinessPayload(),
  result = resultFixture(),
  storage = fakeRegistryStorage(),
} = {}) {
  const calls = [];
  const fetchImpl = makeRenderFetch({ calls, payload });
  const prepared = await prepareOpsRegistryEnrollment({
    result,
    mode: "required",
    env: BASE_ENV,
    fetchImpl,
    tokenFactory: () => "x".repeat(43),
  });
  markPreparedClientDeployment(prepared, {
    deployId: "dep-client",
    deployStatus: "live",
  });
  await deployPreparedRegistryToken({
    prepared,
    result,
    env: BASE_ENV,
    renderClient: fakeRenderClient(),
    fetchImpl,
  });
  return { calls, fetchImpl, prepared, result, storage };
}

test("Ops token env key is deterministic and contains no client punctuation", () => {
  assert.equal(defaultTokenEnvKey("acme-clinic"), "OPS_CLIENT_TOKEN_ACME_CLINIC");
  assert.equal(defaultTokenEnvKey("Acme Clinic #2"), "OPS_CLIENT_TOKEN_ACME_CLINIC_2");
});

test("auto mode stays backwards compatible when no Ops control plane is configured", () => {
  const plan = buildOpsEnrollmentPlan({ clientSlug: "acme", env: {} });
  assert.equal(plan.mode, "auto");
  assert.equal(plan.enabled, false);
  assert.equal(plan.configured, false);
  assert.deepEqual(plan.missing, [
    "PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID",
    "OPS_DATABASE_URL",
  ]);
});

test("required or partially configured auto mode fails before provisioning can create resources", () => {
  assert.throws(
    () => requireOpsEnrollmentConfig({ clientSlug: "acme", mode: "required", env: {} }),
    (err) => err.code === "OPS_ENROLLMENT_CONFIG_MISSING" && err.stage === "validation"
  );
  assert.throws(
    () => requireOpsEnrollmentConfig({
      clientSlug: "acme",
      mode: "auto",
      env: { PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID: "srv-registry" },
    }),
    (err) => err.code === "OPS_ENROLLMENT_CONFIG_MISSING"
  );
});

test("client and registry service IDs must differ before any secret mutation", async () => {
  const calls = [];
  const result = resultFixture();
  await assert.rejects(
    prepareOpsRegistryEnrollment({
      result,
      mode: "required",
      env: {
        ...BASE_ENV,
        PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID: result.render.serviceId,
      },
      fetchImpl: makeRenderFetch({ calls }),
      tokenFactory: () => "x".repeat(43),
    }),
    (err) => err.code === "OPS_ENROLLMENT_SERVICE_ID_COLLISION"
      && err.stage === "validation"
  );
  assert.deepEqual(calls, []);
});

test("generated readiness token uses 32 random bytes and is URL-safe", () => {
  let requested = 0;
  const token = generateOpsReadinessToken((size) => {
    requested = size;
    return Buffer.alloc(size, 0xab);
  });
  assert.equal(requested, 32);
  assert.ok(token.length >= 32);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
});

test("automated enrollment configures both secret env vars, deploys, verifies contract, and upserts only secret-free metadata", async () => {
  const calls = [];
  const fetchImpl = makeRenderFetch({ calls });
  const token = "secret-token-that-must-never-be-serialized-123456789";
  const storage = fakeRegistryStorage();
  const result = resultFixture();

  const prepared = await prepareOpsRegistryEnrollment({
    result,
    mode: "required",
    env: BASE_ENV,
    fetchImpl,
    tokenFactory: () => token,
  });

  assert.equal(prepared.state.status, "prepared");
  assert.equal(prepared.state.clientTokenConfigured, true);
  assert.equal(prepared.state.registryTokenConfigured, true);
  assert.equal(prepared.token, token);
  assert.equal(JSON.stringify(prepared).includes(token), false);

  const envPuts = calls.filter((call) => call.method === "PUT");
  assert.equal(envPuts.length, 2);
  assert.equal(envPuts[0].pathname.endsWith("/srv-client/env-vars/OPS_READINESS_TOKEN"), true);
  assert.equal(envPuts[0].body.value, token);
  assert.equal(
    envPuts[1].pathname.endsWith("/srv-registry/env-vars/OPS_CLIENT_TOKEN_ACME_CLINIC"),
    true
  );
  assert.equal(envPuts[1].body.value, token);

  markPreparedClientDeployment(prepared, { deployId: "dep-final", deployStatus: "live" });
  await deployPreparedRegistryToken({
    prepared,
    result,
    env: BASE_ENV,
    renderClient: fakeRenderClient(),
    fetchImpl,
  });
  const state = await verifyAndRegisterPreparedEnrollment({
    prepared,
    result,
    env: BASE_ENV,
    fetchImpl,
    createPool: storage.createPool,
    migrate: storage.migrate,
    createRepo: storage.createRepo,
    now: () => new Date("2026-09-10T12:02:00.000Z"),
  });

  assert.equal(state.status, "verified");
  assert.equal(state.verified, true);
  assert.equal(state.endpointVerified, true);
  assert.equal(state.registryRecordUpserted, true);
  assert.equal(state.readinessStatus, "ready");
  assert.equal(state.remoteCommitSha, "commit-123");
  assert.equal(state.verifiedAt, "2026-09-10T12:02:00.000Z");

  const upsert = storage.calls.find(([name]) => name === "upsert")[1];
  assert.equal(upsert.clientSlug, "acme-clinic");
  assert.equal(upsert.displayName, "Acme Clinic");
  assert.equal(upsert.tokenEnvKey, "OPS_CLIENT_TOKEN_ACME_CLINIC");
  assert.deepEqual(upsert.purchasedChannels, ["whatsapp", "instagram"]);
  assert.equal(JSON.stringify(upsert).includes(token), false);
  assert.equal(JSON.stringify(state).includes(token), false);
});

test("exact client identity mismatch fails before a registry record is created", async () => {
  const context = await preparedForVerification({
    payload: readinessPayload({ client: { slug: "wrong-client" } }),
  });

  await assert.rejects(
    verifyAndRegisterPreparedEnrollment({
      prepared: context.prepared,
      result: context.result,
      env: BASE_ENV,
      fetchImpl: context.fetchImpl,
      createPool: context.storage.createPool,
      migrate: context.storage.migrate,
      createRepo: context.storage.createRepo,
    }),
    (err) => err.code === "OPS_ENROLLMENT_ENDPOINT_VERIFICATION_FAILED"
      && /identity mismatch/i.test(err.message)
  );
  assert.equal(context.storage.calls.some(([name]) => name === "upsert"), false);
});

test("missing or mismatched remote business profile fails closed before registry mutation", async () => {
  for (const businessType of [null, "home_renovation"]) {
    const storage = fakeRegistryStorage();
    const context = await preparedForVerification({
      payload: readinessPayload({ client: { businessType } }),
      storage,
    });
    await assert.rejects(
      verifyAndRegisterPreparedEnrollment({
        prepared: context.prepared,
        result: context.result,
        env: BASE_ENV,
        fetchImpl: context.fetchImpl,
        createPool: storage.createPool,
        migrate: storage.migrate,
        createRepo: storage.createRepo,
      }),
      (err) => err.code === "OPS_ENROLLMENT_ENDPOINT_VERIFICATION_FAILED"
        && /profile mismatch/i.test(err.message)
    );
    assert.equal(storage.calls.some(([name]) => name === "upsert"), false);
  }
});

test("purchased-channel contract mismatch fails closed before registry mutation", async () => {
  const storage = fakeRegistryStorage();
  const context = await preparedForVerification({
    payload: readinessPayload({
      readiness: {
        channelContract: {
          configured: true,
          channels: ["whatsapp"],
          error: null,
        },
      },
    }),
    storage,
  });

  await assert.rejects(
    verifyAndRegisterPreparedEnrollment({
      prepared: context.prepared,
      result: context.result,
      env: BASE_ENV,
      fetchImpl: context.fetchImpl,
      createPool: storage.createPool,
      migrate: storage.migrate,
      createRepo: storage.createRepo,
    }),
    (err) => err.code === "OPS_ENROLLMENT_ENDPOINT_VERIFICATION_FAILED"
      && /purchased-channel contract mismatch/i.test(err.message)
  );
  assert.equal(storage.calls.some(([name]) => name === "upsert"), false);
});

test("recovery flow can explicitly redeploy the client to apply a rotated token", async () => {
  const calls = [];
  const fetchImpl = makeRenderFetch({ calls });
  const result = resultFixture();
  let prepared = await prepareOpsRegistryEnrollment({
    result,
    mode: "required",
    env: BASE_ENV,
    fetchImpl,
    tokenFactory: () => "r".repeat(43),
  });
  prepared = await deployPreparedClientToken({
    prepared,
    result,
    env: BASE_ENV,
    renderClient: fakeRenderClient(),
    fetchImpl,
  });
  assert.equal(prepared.state.clientDeployId, "dep-srv-client");
  assert.equal(prepared.state.clientDeployStatus, "live");
});

test("accepted deploy ID survives a later deployment wait failure for recovery", async () => {
  const calls = [];
  const fetchImpl = makeRenderFetch({ calls });
  const result = resultFixture();
  const prepared = await prepareOpsRegistryEnrollment({
    result,
    mode: "required",
    env: BASE_ENV,
    fetchImpl,
    tokenFactory: () => "r".repeat(43),
  });
  markPreparedClientDeployment(prepared, {
    deployId: "dep-client",
    deployStatus: "live",
  });

  await assert.rejects(
    deployPreparedRegistryToken({
      prepared,
      result,
      env: BASE_ENV,
      fetchImpl,
      renderClient: {
        async waitForDeploy() {
          const error = new Error("deploy wait timed out");
          error.resourceStatus = "timeout";
          throw error;
        },
      },
    }),
    (err) => err.code === "OPS_ENROLLMENT_REGISTRY_DEPLOY_FAILED"
      && err.publicState?.registryDeployId === "dep-srv-registry"
      && err.publicState?.registryDeployStatus === "timeout"
  );
  assert.equal(prepared.state.registryDeployId, "dep-srv-registry");
  assert.equal(prepared.state.registryDeployStatus, "timeout");
});

test("registry metadata and first snapshot are rolled back together when seeding fails", async () => {
  const queries = [];
  const connection = {
    async query(sql) {
      queries.push(String(sql).trim());
      return { rows: [] };
    },
    release() {
      queries.push("RELEASE");
    },
  };
  const pool = {
    async connect() {
      return connection;
    },
    async end() {
      queries.push("POOL_END");
    },
  };

  await assert.rejects(
    withOpsRepo(
      BASE_ENV,
      {
        createPool: () => pool,
        migrate: async () => {},
        createRepo: () => ({
          async upsertClient() {},
          async recordPollSuccess() {
            throw new Error("snapshot insert failed");
          },
        }),
      },
      async (repo) => {
        await repo.upsertClient({});
        await repo.recordPollSuccess("acme", {});
      }
    ),
    /snapshot insert failed/
  );

  assert.equal(queries.includes("BEGIN"), true);
  assert.equal(queries.includes("ROLLBACK"), true);
  assert.equal(queries.includes("COMMIT"), false);
  assert.equal(queries.includes("RELEASE"), true);
  assert.equal(queries.includes("POOL_END"), true);
});

test("partial failures expose only safe recovery state", async () => {
  const token = "z".repeat(43);
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (options.method === "PUT" && parsed.pathname.includes("/srv-client/")) {
      return response(200, {});
    }
    if (options.method === "PUT" && parsed.pathname.includes("/srv-registry/")) {
      return response(500, { message: `bad registry token ${token}` });
    }
    throw new Error("Unexpected request");
  };

  let caught;
  try {
    await prepareOpsRegistryEnrollment({
      result: resultFixture(),
      mode: "required",
      env: BASE_ENV,
      fetchImpl,
      tokenFactory: () => token,
    });
  } catch (err) {
    caught = err;
  }

  assert.equal(caught.code, "OPS_ENROLLMENT_REGISTRY_TOKEN_CONFIG_FAILED");
  assert.equal(caught.message.includes(token), false);
  const state = opsEnrollmentFailureState(caught);
  assert.equal(state.clientTokenConfigured, true);
  assert.equal(state.registryTokenConfigured, false);
  assert.equal(state.status, "failed");
  assert.equal(JSON.stringify(state).includes(token), false);
});
