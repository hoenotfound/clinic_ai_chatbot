const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildProvisioningPlan,
  provisionClient,
  publicPlan,
} = require("../src/provisioning/clientProvisioner");
const {
  buildProvisioningReceipt,
  parseArgs,
  runtimeEnvForReadinessPreflight,
} = require("../scripts/provisionClient");

const CONTROL_ENV = {
  PROVISIONING_RENDER_API_KEY: "render-control",
  PROVISIONING_RENDER_OWNER_ID: "owner-1",
  PROVISIONING_NEON_API_KEY: "neon-control",
  PROVISIONING_RENDER_PLAN: "starter",
  PROVISIONING_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  PROVISIONING_CLOUDFLARE_API_TOKEN: "cloudflare-control",
  PROVISIONING_R2_MODE: "required",
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
          id: "srv-r2",
          name: payload.name,
          serviceDetails: { url: `https://${payload.name}.onrender.com` },
        },
        deployId: "dep-r2",
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
        project: { id: "neon-r2", name: payload.name },
        databases: [{ name: "neondb" }],
        roles: [{ name: "owner" }],
        operations: [],
      };
    },
    async waitForOperations(projectId, operations) {
      calls.push(["neon.wait", projectId, operations]);
    },
    async getPooledConnectionUri(payload) {
      calls.push(["neon.uri", payload]);
      return "postgresql://user:db-secret@pooler.example/neondb?sslmode=require";
    },
    ...overrides.neonClient,
  };
  const r2Client = {
    async findBucketsByExactName(name) {
      calls.push(["r2.find", name]);
      return [];
    },
    async createBucket(payload) {
      calls.push(["r2.bucket.create", payload]);
      return { name: payload.name, location: payload.locationHint, jurisdiction: "default" };
    },
    async createBucketCredentials(payload) {
      calls.push(["r2.credentials.create", payload]);
      return {
        tokenId: "b".repeat(32),
        tokenName: payload.tokenName,
        accessKeyId: "b".repeat(32),
        secretAccessKey: "derived-r2-secret",
      };
    },
    ...overrides.r2Client,
  };
  return { calls, renderClient, neonClient, r2Client };
}

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

test("dry-run plan exposes automated R2 intent without Cloudflare control secrets", () => {
  const plan = buildProvisioningPlan({
    clientSlug: "Acme Cabinets",
    industry: "renovation",
    requiredChannels: "whatsapp",
    runtimeEnv: runtimeEnv(),
  }, CONTROL_ENV);
  const output = publicPlan(plan);

  assert.equal(output.r2.enabled, true);
  assert.equal(output.r2.mode, "required");
  assert.equal(output.r2.bucketName, "da-chatbot-acme-cabinets-media");
  assert.equal(output.r2.locationHint, "apac");
  assert.equal(Object.prototype.hasOwnProperty.call(output.r2, "accountId"), false);
  assert.equal(JSON.stringify(output).includes(CONTROL_ENV.PROVISIONING_CLOUDFLARE_API_TOKEN), false);
  assert.deepEqual(
    output.render.runtimeEnvKeys.filter((key) => key.startsWith("R2_")),
    ["R2_ACCESS_KEY_ID", "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_SECRET_ACCESS_KEY"]
  );
});

test("automated R2 rejects manual R2 runtime values before provider work", () => {
  assert.throws(
    () => buildProvisioningPlan({
      clientSlug: "acme",
      industry: "generic",
      runtimeEnv: { ...runtimeEnv(), R2_BUCKET_NAME: "manual-bucket" },
    }, CONTROL_ENV),
    (err) => err.code === "R2_RUNTIME_ENV_RESERVED" && err.stage === "validation"
  );
});

test("R2 bucket collision participates in the preflight before any resource creation", async () => {
  const clients = fakeClients({
    r2Client: {
      async findBucketsByExactName(name) {
        clients.calls.push(["r2.find", name]);
        return [{ name }];
      },
    },
  });

  await assert.rejects(
    provisionClient({
      clientSlug: "acme",
      industry: "generic",
      runtimeEnv: runtimeEnv(),
    }, {
      execute: true,
      env: CONTROL_ENV,
      renderClient: clients.renderClient,
      neonClient: clients.neonClient,
      r2Client: clients.r2Client,
    }),
    (err) => err.code === "RESOURCE_NAME_COLLISION"
      && err.stage === "preflight"
      && /R2 bucket/.test(err.message)
  );

  assert.equal(clients.calls.some(([name]) => name === "neon.create"), false);
  assert.equal(clients.calls.some(([name]) => name === "r2.bucket.create"), false);
  assert.equal(clients.calls.some(([name]) => name === "render.create"), false);
});

test("successful automated R2 provisioning injects only the client credentials into Render", async () => {
  const clients = fakeClients();
  const result = await provisionClient({
    clientSlug: "acme",
    industry: "generic",
    requiredChannels: "whatsapp",
    runtimeEnv: runtimeEnv(),
  }, {
    execute: true,
    env: CONTROL_ENV,
    renderClient: clients.renderClient,
    neonClient: clients.neonClient,
    r2Client: clients.r2Client,
  });

  assert.equal(result.r2.provisioned, true);
  assert.equal(result.r2.bucketName, "da-chatbot-acme-media");
  assert.equal(result.r2.tokenId, "b".repeat(32));

  const renderPayload = clients.calls.find(([name]) => name === "render.create")[1];
  const envByKey = new Map(renderPayload.envVars.map((entry) => [entry.key, entry.value]));
  assert.equal(envByKey.get("R2_ACCOUNT_ID"), CONTROL_ENV.PROVISIONING_CLOUDFLARE_ACCOUNT_ID);
  assert.equal(envByKey.get("R2_BUCKET_NAME"), "da-chatbot-acme-media");
  assert.equal(envByKey.get("R2_ACCESS_KEY_ID"), "b".repeat(32));
  assert.equal(envByKey.get("R2_SECRET_ACCESS_KEY"), "derived-r2-secret");
  assert.equal(envByKey.has("PROVISIONING_CLOUDFLARE_API_TOKEN"), false);

  const neonCreate = clients.calls.findIndex(([name]) => name === "neon.create");
  const bucketCreate = clients.calls.findIndex(([name]) => name === "r2.bucket.create");
  const credentialsCreate = clients.calls.findIndex(([name]) => name === "r2.credentials.create");
  const renderCreate = clients.calls.findIndex(([name]) => name === "render.create");
  assert.equal(neonCreate < bucketCreate, true);
  assert.equal(bucketCreate < credentialsCreate, true);
  assert.equal(credentialsCreate < renderCreate, true);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("derived-r2-secret"), false);
  assert.equal(serialized.includes("db-secret"), false);
  assert.equal(serialized.includes(CONTROL_ENV.PROVISIONING_CLOUDFLARE_API_TOKEN), false);
});

test("R2 credential failure preserves safe recovery identifiers and never creates Render", async () => {
  const clients = fakeClients({
    r2Client: {
      async createBucketCredentials(payload) {
        clients.calls.push(["r2.credentials.create", payload]);
        const err = new Error("credential creation interrupted");
        err.ambiguous = true;
        err.partialResources = {
          r2TokenId: "c".repeat(32),
          r2TokenName: payload.tokenName,
        };
        throw err;
      },
    },
  });

  await assert.rejects(
    provisionClient({
      clientSlug: "acme",
      industry: "generic",
      runtimeEnv: runtimeEnv(),
    }, {
      execute: true,
      env: CONTROL_ENV,
      renderClient: clients.renderClient,
      neonClient: clients.neonClient,
      r2Client: clients.r2Client,
    }),
    (err) => {
      assert.equal(err.code, "R2_CREDENTIAL_CREATE_FAILED");
      assert.equal(err.stage, "r2_credentials_create");
      assert.equal(err.retrySafe, false);
      assert.equal(err.partialResources.neonProjectId, "neon-r2");
      assert.equal(err.partialResources.r2BucketName, "da-chatbot-acme-media");
      assert.equal(err.partialResources.r2TokenId, "c".repeat(32));
      return true;
    }
  );
  assert.equal(clients.calls.some(([name]) => name === "render.create"), false);
});

test("manual R2 remains backward-compatible when automated R2 is not configured", async () => {
  const env = {
    PROVISIONING_RENDER_API_KEY: "render-control",
    PROVISIONING_RENDER_OWNER_ID: "owner-1",
    PROVISIONING_NEON_API_KEY: "neon-control",
    PROVISIONING_RENDER_PLAN: "starter",
  };
  const clients = fakeClients();
  const manual = {
    ...runtimeEnv(),
    R2_ACCOUNT_ID: "manual-account",
    R2_ACCESS_KEY_ID: "manual-access",
    R2_SECRET_ACCESS_KEY: "manual-secret",
    R2_BUCKET_NAME: "manual-bucket",
  };
  const result = await provisionClient({
    clientSlug: "legacy",
    industry: "generic",
    runtimeEnv: manual,
  }, {
    execute: true,
    env,
    renderClient: clients.renderClient,
    neonClient: clients.neonClient,
  });

  assert.equal(result.r2.enabled, false);
  assert.equal(clients.calls.some(([name]) => name.startsWith("r2.")), false);
  const renderPayload = clients.calls.find(([name]) => name === "render.create")[1];
  const envByKey = new Map(renderPayload.envVars.map((entry) => [entry.key, entry.value]));
  assert.equal(envByKey.get("R2_BUCKET_NAME"), "manual-bucket");
  assert.equal(envByKey.get("R2_SECRET_ACCESS_KEY"), "manual-secret");
});

test("provision-client readiness preflight accepts generated R2 without mutating client runtime input", () => {
  const runtime = runtimeEnv();
  const plan = buildProvisioningPlan({
    clientSlug: "acme",
    industry: "generic",
    runtimeEnv: runtime,
  }, CONTROL_ENV);
  const prepared = runtimeEnvForReadinessPreflight(runtime, plan);

  assert.notEqual(prepared, runtime);
  assert.equal(prepared.R2_BUCKET_NAME, plan.r2.bucketName);
  assert.equal(prepared.R2_ACCOUNT_ID, "managed-by-provisioner");
  assert.equal(runtime.R2_BUCKET_NAME, undefined);
});

test("CLI accepts explicit R2 rollout controls", () => {
  const parsed = parseArgs([
    "--client", "acme",
    "--industry", "generic",
    "--channels", "whatsapp",
    "--r2-provisioning", "required",
    "--r2-location", "apac",
  ]);
  assert.equal(parsed.r2Provisioning, "required");
  assert.equal(parsed.r2Location, "apac");
});

test("version 4 provisioning receipt stores only secret-free R2 recovery metadata", () => {
  const receipt = buildProvisioningReceipt({
    clientSlug: "acme",
    industry: "generic",
    requiredChannels: ["whatsapp"],
    profileContract: { envKey: "INITIAL_BUSINESS_TYPE", value: "generic" },
    neon: { projectId: "neon-r2" },
    r2: {
      enabled: true,
      provisioned: true,
      bucketName: "da-chatbot-acme-media",
      tokenId: "b".repeat(32),
      tokenName: "da-chatbot-acme-r2",
      locationHint: "apac",
    },
    render: { serviceId: "srv-r2" },
    runtimeFinalization: null,
    opsEnrollment: null,
    readiness: null,
  }, new Date("2026-09-14T04:00:00.000Z"));

  assert.equal(receipt.version, 4);
  assert.equal(receipt.r2.bucketName, "da-chatbot-acme-media");
  assert.equal(receipt.r2.tokenId, "b".repeat(32));
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("R2_SECRET_ACCESS_KEY"), false);
  assert.equal(serialized.includes("cloudflare-control"), false);
});
