const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("provisioning preflights Ops enrollment before any client cloud creation", () => {
  const source = read("scripts/provisionClient.js");
  const preflight = source.indexOf("requireOpsEnrollmentConfig({");
  const provision = source.indexOf("result = await provisionClient(input");
  assert.ok(preflight >= 0);
  assert.ok(provision > preflight);
});

test("provisioning configures Ops secrets before the existing final deploy applies the client token", () => {
  const source = read("scripts/provisionClient.js");
  const prepare = source.indexOf("preparedOps = await prepareOpsRegistryEnrollment({");
  const finalize = source.indexOf("const finalized = await finalizeRenderRuntime({");
  const registryDeploy = source.indexOf("await deployPreparedRegistryToken({");
  const verify = source.indexOf("opsEnrollment = await verifyAndRegisterPreparedEnrollment({");

  assert.ok(prepare >= 0);
  assert.ok(finalize > prepare);
  assert.ok(registryDeploy > finalize);
  assert.ok(verify > registryDeploy);
});

test("Ops enrollment failure does not bypass admin-password finalization or readiness verification", () => {
  const source = read("scripts/provisionClient.js");
  assert.match(source, /opsEnrollment = opsEnrollmentFailureState\(err, opsEnrollment\)/);
  assert.match(source, /const finalized = await finalizeRenderRuntime\(\{/);
  assert.match(source, /readiness = await verifyClientReadiness\(\{/);
});

test("provisioning receipts store enrollment state but never the private prepared token", () => {
  const source = read("scripts/provisionClient.js");
  assert.match(source, /opsEnrollment: result\.opsEnrollment/);
  assert.doesNotMatch(source, /opsEnrollment:\s*preparedOps/);

  const enrollmentSource = read("src/provisioning/opsRegistryEnrollment.js");
  assert.match(enrollmentSource, /Object\.defineProperty\(prepared, "token"/);
  assert.match(enrollmentSource, /enumerable: false/);
});

test("enabled but incomplete Ops enrollment has a dedicated non-zero exit code", () => {
  const source = read("scripts/provisionClient.js");
  assert.match(source, /const OPS_ENROLLMENT_FAILED_EXIT_CODE = 5/);
  assert.match(
    source,
    /result\.opsEnrollment\?\.enabled && result\.opsEnrollment\?\.verified !== true/
  );
});
