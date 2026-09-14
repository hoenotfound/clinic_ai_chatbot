const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  loadReceipt,
  parseArgs,
  provisioningResultFromReceipt,
  recoveryLockName,
  writeEnrollmentToReceipt,
} = require("../scripts/enrollOpsClient");
const { acquireProvisioningLock } = require("../scripts/provisionClient");

function fixture(version = 3) {
  return {
    version,
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

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ops-enroll-lock-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("Ops enrollment recovery CLI accepts only receipt/json controls", () => {
  assert.deepEqual(parseArgs(["--receipt", ".provisioning/acme.json", "--json"]), {
    json: true,
    receiptPath: ".provisioning/acme.json",
  });
  assert.throws(() => parseArgs(["--token", "secret"]), /Unknown argument/);
});

test("receipt loader accepts both v3 and v4 receipts and rejects future versions", (t) => {
  const directory = tempDir(t);
  for (const version of [3, 4]) {
    const receiptPath = path.join(directory, `v${version}.json`);
    fs.writeFileSync(receiptPath, `${JSON.stringify(fixture(version))}\n`);
    assert.equal(loadReceipt(receiptPath).receipt.version, version);
  }
  const futurePath = path.join(directory, "v5.json");
  fs.writeFileSync(futurePath, `${JSON.stringify(fixture(5))}\n`);
  assert.throws(() => loadReceipt(futurePath), /Unsupported provisioning receipt version 5/);
});

test("receipt converts to the minimum safe provisioning result needed for re-enrollment", () => {
  const v4 = fixture(4);
  v4.r2 = {
    enabled: true,
    provisioned: true,
    bucketName: "da-chatbot-acme-clinic-media",
    tokenId: "token-1",
  };
  const result = provisioningResultFromReceipt(v4);
  assert.equal(result.clientSlug, "acme-clinic");
  assert.equal(result.render.serviceId, "srv-client");
  assert.equal(result.render.url, "https://client.example");
  assert.deepEqual(result.requiredChannels, ["whatsapp", "instagram"]);
  assert.equal(result.r2.bucketName, "da-chatbot-acme-clinic-media");
  assert.equal(Object.hasOwn(result, "runtimeEnv"), false);
});

test("recovery uses the same per-client resource lock as normal provisioning", (t) => {
  const receipt = fixture();
  const name = recoveryLockName(receipt);
  assert.equal(name, "da-chatbot-acme-clinic");

  const baseDir = tempDir(t);
  const first = acquireProvisioningLock(name, { baseDir });
  t.after(() => first.release());
  assert.throws(
    () => acquireProvisioningLock(recoveryLockName(receipt), { baseDir }),
    (err) => err.code === "PROVISIONING_LOCKED"
  );
});

test("recovery updates only secret-free enrollment state atomically", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ops-enroll-receipt-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, "acme.json");
  fs.writeFileSync(receiptPath, `${JSON.stringify(fixture(4), null, 2)}\n`, { mode: 0o600 });

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

  writeEnrollmentToReceipt(receiptPath, fixture(4), enrollment, {
    deployedCommitSha: "new-sha",
  });
  const saved = JSON.parse(fs.readFileSync(receiptPath, "utf8"));

  assert.equal(saved.version, 4);
  assert.equal(saved.opsEnrollment.status, "verified");
  assert.equal(saved.opsEnrollment.tokenEnvKey, "OPS_CLIENT_TOKEN_ACME_CLINIC");
  assert.equal(saved.render.deployedCommitSha, "new-sha");
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(Object.hasOwn(saved.opsEnrollment, "token"), false);
});
