const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recoverInterruptedProvisioning,
  validateExistingRenderService,
} = require("../src/provisioning/clientRecovery");

const CONTROL_ENV = {
  PROVISIONING_RENDER_API_KEY: "render-test",
  PROVISIONING_RENDER_OWNER_ID: "owner-test",
  PROVISIONING_NEON_API_KEY: "neon-test",
  PROVISIONING_RENDER_PLAN: "starter",
  PROVISIONING_CLOUDFLARE_ACCOUNT_ID: "account-test",
  PROVISIONING_CLOUDFLARE_API_TOKEN: "cloudflare-test",
  PROVISIONING_R2_MODE: "required",
};

function runtimeEnv() {
  return {
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-password",
    GEMINI_API_KEY: "gemini-test",
    WHATSAPP_PHONE_NUMBER_ID: "phone-test",
    WHATSAPP_TOKEN: "wa-test",
    WHATSAPP_APP_SECRET: "app-test",
    WHATSAPP_VERIFY_TOKEN: "verify-test",
  };
}

function deps({ jurisdiction = "default", location = "enam" } = {}) {
  const calls = [];
  return {
    calls,
    renderClient: {
      async findServicesByExactName(name) {
        return [{
          id: "srv-test",
          name,
          repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
          branch: "main",
          type: "web_service",
          serviceDetails: { url: `https://${name}.onrender.com`, region: "singapore" },
        }];
      },
    },
    neonClient: {
      async findProjectsByExactName(name) {
        return [{ id: "neon-test", name }];
      },
      async getPooledConnectionUri() {
        return "postgresql://test:test@localhost/neondb";
      },
    },
    r2Client: {
      async findBucketsByExactName(name) {
        return [{ name, location, jurisdiction }];
      },
      async recoverBucketCredentials(payload) {
        calls.push(["r2.credentials.recover", payload]);
        return {
          tokenId: "token-test",
          tokenName: payload.tokenName,
          accessKeyId: "access-test",
          secretAccessKey: "storage-test",
          recovered: true,
          created: false,
        };
      },
    },
  };
}

function recoveryInput() {
  return {
    clientSlug: "acme",
    industry: "generic",
    requiredChannels: "whatsapp",
    runtimeEnv: runtimeEnv(),
  };
}

const discoverNeonDefaultsImpl = async () => ({
  branchId: "branch-main",
  databaseName: "neondb",
  roleName: "owner",
});
const redeployExistingRenderImpl = async () => ({
  deployId: "dep-test",
  deployStatus: "live",
});

test("R2 recovery accepts an actual bucket location different from the best-effort location hint", async () => {
  const dependencies = deps({ location: "enam", jurisdiction: "default" });
  const result = await recoverInterruptedProvisioning(recoveryInput(), {
    env: CONTROL_ENV,
    renderClient: dependencies.renderClient,
    neonClient: dependencies.neonClient,
    r2Client: dependencies.r2Client,
    discoverNeonDefaultsImpl,
    redeployExistingRenderImpl,
  });

  assert.equal(result.r2.locationHint, "apac");
  assert.equal(result.recovery.reusedR2Bucket, true);
  assert.equal(dependencies.calls.length, 1);
});

test("R2 recovery fails closed on a bucket jurisdiction mismatch", async () => {
  const dependencies = deps({ location: "apac", jurisdiction: "eu" });
  await assert.rejects(
    recoverInterruptedProvisioning(recoveryInput(), {
      env: CONTROL_ENV,
      renderClient: dependencies.renderClient,
      neonClient: dependencies.neonClient,
      r2Client: dependencies.r2Client,
      discoverNeonDefaultsImpl,
      redeployExistingRenderImpl,
    }),
    (err) => err.code === "RECOVERY_R2_JURISDICTION_MISMATCH"
  );
  assert.equal(dependencies.calls.length, 0);
});

test("Render recovery fails closed on provider-reported type or region mismatch", () => {
  const plan = {
    render: {
      repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
      branch: "main",
      region: "singapore",
    },
  };

  assert.throws(
    () => validateExistingRenderService({
      id: "srv-test",
      repo: plan.render.repo,
      branch: plan.render.branch,
      type: "cron_job",
      region: plan.render.region,
    }, plan),
    (err) => err.code === "RECOVERY_RENDER_TYPE_MISMATCH"
  );

  assert.throws(
    () => validateExistingRenderService({
      id: "srv-test",
      repo: plan.render.repo,
      branch: plan.render.branch,
      type: "web_service",
      region: "frankfurt",
    }, plan),
    (err) => err.code === "RECOVERY_RENDER_REGION_MISMATCH"
  );
});
