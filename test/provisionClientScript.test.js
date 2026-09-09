const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  acquireProvisioningLock,
  parseArgs,
  readinessFailureReport,
  requireReadinessAdminCredentials,
  safeErrorOutput,
  writeProvisioningReceipt,
} = require("../scripts/provisionClient");

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "client-provisioning-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("same-machine provisioning lock refuses a concurrent run for the same resource", (t) => {
  const baseDir = tempDir(t);
  const first = acquireProvisioningLock("da-chatbot-acme", { baseDir });
  t.after(() => first.release());

  assert.throws(
    () => acquireProvisioningLock("da-chatbot-acme", { baseDir }),
    (err) => err.code === "PROVISIONING_LOCKED" && err.stage === "preflight"
  );

  first.release();
  const second = acquireProvisioningLock("da-chatbot-acme", { baseDir });
  second.release();
});

test("stale local provisioning lock is recovered when its process is no longer running", (t) => {
  const baseDir = tempDir(t);
  const stateDir = path.join(baseDir, ".provisioning");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "da-chatbot-acme.lock"),
    JSON.stringify({ resourceName: "da-chatbot-acme", pid: 99999999 })
  );

  const lock = acquireProvisioningLock("da-chatbot-acme", { baseDir });
  lock.release();
  assert.equal(fs.existsSync(path.join(stateDir, "da-chatbot-acme.lock")), false);
});

test("provision CLI accepts an explicit required-channel contract", () => {
  const args = parseArgs([
    "--client", "acme",
    "--industry", "home_renovation",
    "--channels", "whatsapp,instagram",
  ]);
  assert.equal(args.channels, "whatsapp,instagram");
});

test("execution readiness requires the bootstrap admin credentials that are copied to the client", () => {
  assert.deepEqual(
    requireReadinessAdminCredentials({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret-pass" }),
    { username: "admin", password: "secret-pass" }
  );
  assert.throws(
    () => requireReadinessAdminCredentials({ ADMIN_USERNAME: "admin" }),
    (err) => err.code === "READINESS_ADMIN_CREDENTIALS_REQUIRED"
  );
});

test("successful provisioning receipt is secret-free and stores finalization/readiness identifiers", (t) => {
  const baseDir = tempDir(t);
  const result = {
    mode: "executed",
    clientSlug: "acme",
    industry: "home_renovation",
    requiredChannels: ["whatsapp", "instagram"],
    neon: {
      projectId: "neon-123",
      projectName: "da-chatbot-acme",
      region: "aws-ap-southeast-1",
    },
    render: {
      serviceId: "srv-123",
      serviceName: "da-chatbot-acme",
      url: "https://da-chatbot-acme.onrender.com",
      deployId: "dep-123",
      deployStatus: "live",
      deployedCommitSha: "abc123",
      region: "singapore",
      plan: "starter",
      repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
      branch: "main",
      healthCheckPath: "/",
    },
    runtimeFinalization: {
      publicBaseUrlConfigured: true,
      adminPasswordRemoved: true,
      deployId: "dep-final",
      deployStatus: "live",
      deployedCommitSha: "abc123",
    },
    profileContract: {
      envKey: "INITIAL_BUSINESS_TYPE",
      value: "home_renovation",
      lockedOnFirstStartup: true,
    },
    readiness: {
      status: "needs_attention",
      ready: false,
      verificationCompleted: true,
      checkedAt: "2026-09-08T12:01:00.000Z",
      requiredChannels: ["whatsapp", "instagram"],
      blocking: [{ key: "instagram", status: "warning", summary: "Send a test message." }],
    },
  };

  const { receiptPath } = writeProvisioningReceipt(result, {
    baseDir,
    now: new Date("2026-09-08T12:00:00.000Z"),
  });
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

  assert.equal(saved.version, 3);
  assert.equal(saved.completedAt, "2026-09-08T12:00:00.000Z");
  assert.equal(saved.lastVerifiedAt, "2026-09-08T12:01:00.000Z");
  assert.equal(saved.render.serviceId, "srv-123");
  assert.equal(saved.render.deployedCommitSha, "abc123");
  assert.equal(saved.runtimeFinalization.adminPasswordRemoved, true);
  assert.equal(saved.runtimeFinalization.deployId, "dep-final");
  assert.equal(saved.neon.projectId, "neon-123");
  assert.deepEqual(saved.requiredChannels, ["whatsapp", "instagram"]);
  assert.equal(saved.readiness.status, "needs_attention");
  assert.equal(JSON.stringify(saved).includes("DATABASE_URL"), false);
  assert.equal(JSON.stringify(saved).includes("API_KEY"), false);
  assert.equal(JSON.stringify(saved).includes("ADMIN_PASSWORD"), false);
});

test("readiness transport/auth failure is classified separately from verified needs-attention", () => {
  const report = readinessFailureReport(
    Object.assign(new Error("Administrator login failed"), { code: "READINESS_LOGIN_REJECTED" }),
    { industry: "home_renovation", channels: ["whatsapp"] }
  );
  assert.equal(report.status, "verification_failed");
  assert.equal(report.ready, false);
  assert.equal(report.verificationCompleted, false);
  assert.equal(report.blocking[0].key, "READINESS_LOGIN_REJECTED");
});

test("CLI error output redacts runtime and control-plane secrets defensively", () => {
  const output = safeErrorOutput(
    new Error("provider echoed gemini-secret and render-control-key"),
    ["gemini-secret", "render-control-key"]
  );

  assert.equal(output.error.includes("gemini-secret"), false);
  assert.equal(output.error.includes("render-control-key"), false);
  assert.equal(output.error.includes("[REDACTED]"), true);
});