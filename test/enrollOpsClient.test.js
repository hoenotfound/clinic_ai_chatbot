const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  parseArgs,
  provisioningResultFromReceipt,
  writeEnrollmentToReceipt,
} = require("../scripts/enrollOpsClient");

function fixture() {
  return {
    version: 3,
    completedAt: "2026-09-10T12:00:00.000Z",
    clientSlug: "acme-clinic",
    industry: "aesthetic_clinic",
    requiredChannels: ["whatsapp", "instagram"],
    profileContract: {
      envKey: "INITIAL_BUSINESS_TYPE",
      value: "aesthetic_clinic",
      lockedOnFirstStartup: true,
    },
    neon: {
      projectId: "neon-1",
      projectName: "da-chatbot-acme-clinic",
    },
    render: {
      serviceId: "srv-client",
      serviceName: "da-chatbot-acme-clinic",
      url: "https://client.example",
      deployedCommitSha: "old-sha",
    },
  };
}

test("Ops enrollment recovery CLI accepts only receipt/json controls", () => {
  assert.deepEqual(parseArgs(["--receipt", ".provisioning/acme.json", "--json"]), {
    json: true,
    receiptPath: ".provisioning/acme.json",
  });
  assert.throws(() => parseArgs(["--token", "secret"]), /Unknown argument/);
});

test("receipt converts to the minimum safe provisioning result needed for re-enrollment", () => {
  const result = provisioningResultFromReceipt(fixture());
  assert.equal(result.clientSlug, "acme-clinic");
  assert.equal(result.render.serviceId, "srv-client");
  assert.equal(result.render.url, "https://client.example");
  assert.deepEqual(result.requiredChannels, ["whatsapp", "instagram"]);
  assert.equal(Object.hasOwn(result, "runtimeEnv"), false);
});

test("recovery updates only secret-free enrollment state atomically", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ops-enroll-receipt-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, "acme.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(fixture(), null, 2)}\n`, { mode: 0o600 });

  const secret = "this-token-must-never-be-written";
  const enrollment = {
    mode: "required",
    enabled: true,
    status: "verified",
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME_CLINIC",
    registryServiceId: "srv-registry",
    clientTokenConfigured: true,
    registryTokenConfigured: true,
    clientDeployId: "dep-client",
    clientDeployStatus: "live",
    registryDeployId: "dep-registry",
    registryDeployStatus: "live",
    endpointVerified: true,
    registryRecordUpserted: true,
    verified: true,
    verifiedAt: "2026-09-10T12:05:00.000Z",
    readinessStatus: "ready",
    remoteCommitSha: "new-sha",
  };

  writeEnrollmentToReceipt(receiptPath, fixture(), enrollment, {
    deployedCommitSha: "new-sha",
  });
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

  assert.equal(saved.opsEnrollment.status, "verified");
  assert.equal(saved.opsEnrollment.tokenEnvKey, "OPS_CLIENT_TOKEN_ACME_CLINIC");
  assert.equal(saved.render.deployedCommitSha, "new-sha");
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(Object.hasOwn(saved.opsEnrollment, "token"), false);
});
