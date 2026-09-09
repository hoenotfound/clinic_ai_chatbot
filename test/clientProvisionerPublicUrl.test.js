const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildProvisioningPlan,
  ClientProvisioningError,
} = require("../src/provisioning/clientProvisioner");

test("PUBLIC_BASE_URL is provisioner-owned and cannot be supplied by client runtime input", () => {
  assert.throws(
    () => buildProvisioningPlan({
      clientSlug: "client-one",
      industry: "generic",
      runtimeEnv: { PUBLIC_BASE_URL: "https://wrong.example" },
    }, {}),
    (err) => err instanceof ClientProvisioningError && err.code === "RUNTIME_ENV_RESERVED"
  );
});
