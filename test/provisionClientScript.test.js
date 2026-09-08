const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  acquireProvisioningLock,
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

test("successful provisioning receipt is secret-free and contains recovery identifiers", (t) => {
  const baseDir = tempDir(t);
  const result = {
    mode: "executed",
    clientSlug: "acme",
    industry: "home_renovation",
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
      region: "singapore",
      plan: "starter",
      repo: "https://github.com/hoenotfound/clinic_ai_chatbot",
      branch: "main",
      healthCheckPath: "/",
    },
    profileContract: {
      envKey: "INITIAL_BUSINESS_TYPE",
      value: "home_renovation",
      lockedOnFirstStartup: true,
    },
  };

  const { receiptPath } = writeProvisioningReceipt(result, {
    baseDir,
    now: new Date("2026-09-08T12:00:00.000Z"),
  });
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

  assert.equal(saved.completedAt, "2026-09-08T12:00:00.000Z");
  assert.equal(saved.render.serviceId, "srv-123");
  assert.equal(saved.render.deployStatus, "live");
  assert.equal(saved.neon.projectId, "neon-123");
  assert.equal(JSON.stringify(saved).includes("DATABASE_URL"), false);
  assert.equal(JSON.stringify(saved).includes("API_KEY"), false);
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
