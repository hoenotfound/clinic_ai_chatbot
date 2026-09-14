const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recoverInterruptedProvisioning,
  selectNeonBranch,
  selectNeonDefaults,
  validateExistingRenderService,
} = require("../src/provisioning/clientRecovery");

const CONTROL_ENV = {
  PROVISIONING_RENDER_API_KEY: "render-control",
  PROVISIONING_RENDER_OWNER_ID: "owner-1",
  PROVISIONING_NEON_API_KEY: "neon-control",
  PROVISIONING_RENDER_PLAN: "starter",
  PROVISIONING_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  PROVISIONING_CLOUDFLARE_API_TOKEN: "cloudflare-control",
  PROVISIONING_R2_MODE: "required",
};

function runtimeEnv() {
  return {
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "bootstrap-password",
    GEMINI_API_KEY: "gemini-key",
    WHATSAPP_PHONE_NUMBER_ID: "phone-id",
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_APP_SECRET: "app-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-token",
  };
}

function dependencies({ existingRender = true, existingBucket = true } = {}) {
  const calls = [];
  const renderClient = {
    async findServicesByExactName(name) {
      calls.push(["render.find", name]);
      return existingRender ? [{
        id: "srv-existing",
        name,
        repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
        branch: "main",
        serviceDetails: { url: `https://${name}.onrender.com` },
      }] : [];
    },
    async createWebService(payload) {
      calls.push(["render.create", payload]);
      return {
        service: {
          id: "srv-created",
          name: payload.name,
          serviceDetails: { url: `https://${payload.name}.onrender.com` },
        },
        deployId: "dep-created",
      };
    },
    async waitForDeploy(serviceId, deployId) {
      calls.push(["render.wait", serviceId, deployId]);
      return { id: deployId, status: "live" };
    },
  };
  const neonClient = {
    async findProjectsByExactName(name) {
      calls.push(["neon.find", name]);
      return [{ id: "neon-existing", name }];
    },
    async getPooledConnectionUri(payload) {
      calls.push(["neon.uri", payload]);
      return "postgresql://user:db-secret@pooler.example/neondb?sslmode=require";
    },
  };
  const r2Client = {
    async findBucketsByExactName(name) {
      calls.push(["r2.find", name]);
      return existingBucket ? [{ name, location: "apac" }] : [];
    },
    async createBucket(payload) {
      calls.push(["r2.bucket.create", payload]);
      return { name: payload.name, location: payload.locationHint };
    },
    async recoverBucketCredentials(payload) {
      calls.push(["r2.credentials.recover", payload]);
      return {
        tokenId: "b".repeat(32),
        tokenName: payload.tokenName,
        accessKeyId: "b".repeat(32),
        secretAccessKey: "recovered-r2-secret",
        recovered: existingBucket,
        created: !existingBucket,
      };
    },
  };
  return { calls, renderClient, neonClient, r2Client };
}

function recoveryInput() {
  return {
    clientSlug: "acme",
    industry: "generic",
    requiredChannels: "whatsapp",
    runtimeEnv: runtimeEnv(),
  };
}

function neonDefaults() {
  return { branchId: "branch-main", databaseName: "neondb", roleName: "owner" };
}

test("Neon recovery chooses the active main branch and the database owner role", () => {
  const branches = [
    { id: "old", name: "preview", deleted_at: "2026-01-01T00:00:00Z" },
    { id: "main-id", name: "main" },
  ];
  assert.equal(selectNeonBranch(branches).id, "main-id");
  assert.deepEqual(selectNeonDefaults({
    branches,
    databases: [{ name: "neondb", owner_name: "owner" }, { name: "analytics", owner_name: "analytics-owner" }],
    roles: [{ name: "owner" }, { name: "analytics-owner" }],
  }), {
    branchId: "main-id",
    databaseName: "neondb",
    roleName: "owner",
  });
});

test("Neon recovery fails closed when there is no unique branch", () => {
  assert.throws(
    () => selectNeonBranch([{ id: "one", name: "preview" }, { id: "two", name: "staging" }]),
    (err) => err.code === "RECOVERY_NEON_BRANCH_AMBIGUOUS"
  );
});

test("existing Render service must match the expected repository and branch before adoption", () => {
  const plan = {
    render: {
      repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
      branch: "main",
    },
  };
  assert.throws(
    () => validateExistingRenderService({ id: "srv", repo: "https://example.com/other.git", branch: "main" }, plan),
    (err) => err.code === "RECOVERY_RENDER_REPO_MISMATCH"
  );
  assert.throws(
    () => validateExistingRenderService({ id: "srv", repo: plan.render.repo, branch: "other" }, plan),
    (err) => err.code === "RECOVERY_RENDER_BRANCH_MISMATCH"
  );
});

test("recovery adopts existing Neon/R2/Render, rotates R2 credentials, and returns no secrets", async () => {
  const deps = dependencies({ existingRender: true, existingBucket: true });
  const redeploys = [];
  const result = await recoverInterruptedProvisioning(recoveryInput(), {
    env: CONTROL_ENV,
    renderClient: deps.renderClient,
    neonClient: deps.neonClient,
    r2Client: deps.r2Client,
    discoverNeonDefaultsImpl: async () => neonDefaults(),
    redeployExistingRenderImpl: async (payload) => {
      redeploys.push(payload);
      return { deployId: "dep-recovery", deployStatus: "live" };
    },
  });

  assert.equal(result.recovery.reusedNeon, true);
  assert.equal(result.recovery.reusedR2Bucket, true);
  assert.equal(result.recovery.recoveredR2Token, true);
  assert.equal(result.recovery.reusedRender, true);
  assert.equal(result.r2.bucketName, "da-chatbot-acme-media");
  assert.equal(result.render.serviceId, "srv-existing");
  assert.equal(redeploys.length, 1);
  assert.equal(redeploys[0].managedRuntimeEnv.R2_SECRET_ACCESS_KEY, "recovered-r2-secret");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("recovered-r2-secret"), false);
  assert.equal(serialized.includes("db-secret"), false);
  assert.equal(serialized.includes("cloudflare-control"), false);
  assert.equal(deps.calls.some(([name]) => name === "render.create"), false);
});

test("recovery can recreate the exact missing R2 bucket then create Render without leaking generated credentials", async () => {
  const deps = dependencies({ existingRender: false, existingBucket: false });
  const result = await recoverInterruptedProvisioning(recoveryInput(), {
    env: CONTROL_ENV,
    renderClient: deps.renderClient,
    neonClient: deps.neonClient,
    r2Client: deps.r2Client,
    discoverNeonDefaultsImpl: async () => neonDefaults(),
  });

  assert.equal(result.recovery.createdR2Bucket, true);
  assert.equal(result.recovery.reusedR2Bucket, false);
  assert.equal(result.recovery.createdR2Token, true);
  assert.equal(result.recovery.reusedRender, false);
  assert.equal(result.render.serviceId, "srv-created");
  const bucketCreate = deps.calls.find(([name]) => name === "r2.bucket.create");
  assert.equal(bucketCreate[1].name, "da-chatbot-acme-media");
  const renderCreate = deps.calls.find(([name]) => name === "render.create")[1];
  const envByKey = new Map(renderCreate.envVars.map((entry) => [entry.key, entry.value]));
  assert.equal(envByKey.get("R2_SECRET_ACCESS_KEY"), "recovered-r2-secret");
  assert.match(envByKey.get("DATABASE_URL"), /^postgresql:\/\//);
  assert.equal(JSON.stringify(result).includes("recovered-r2-secret"), false);
});

test("multiple existing Render services fail before R2 credentials are recovered", async () => {
  const deps = dependencies();
  deps.renderClient.findServicesByExactName = async (name) => [
    { id: "srv-one", name },
    { id: "srv-two", name },
  ];

  await assert.rejects(
    recoverInterruptedProvisioning(recoveryInput(), {
      env: CONTROL_ENV,
      renderClient: deps.renderClient,
      neonClient: deps.neonClient,
      r2Client: deps.r2Client,
      discoverNeonDefaultsImpl: async () => neonDefaults(),
    }),
    (err) => err.code === "RECOVERY_RENDER_SERVICE_AMBIGUOUS"
  );
  assert.equal(deps.calls.some(([name]) => name === "r2.credentials.recover"), false);
});
