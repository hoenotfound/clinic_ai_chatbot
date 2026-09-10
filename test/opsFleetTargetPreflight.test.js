const test = require("node:test");
const assert = require("node:assert/strict");

const { validateFleetTargetConfiguration } = require("../scripts/verifyOpsRegistry");

const FULL_SHA = "a".repeat(40);

test("Ops fleet target preflight validates registry fallback evidence when no pin is set", () => {
  assert.deepEqual(validateFleetTargetConfiguration({ RENDER_GIT_COMMIT: FULL_SHA }), {
    ok: true,
    label: "Registry deployment commit is a valid full Git commit SHA",
  });

  const invalidRenderCommit = validateFleetTargetConfiguration({ RENDER_GIT_COMMIT: "main" });
  assert.equal(invalidRenderCommit.ok, false);
  assert.match(invalidRenderCommit.label, /Registry deployment commit must be a full/i);

  const invalidCompatibilityCommit = validateFleetTargetConfiguration({ OPS_REGISTRY_COMMIT: "short-sha" });
  assert.equal(invalidCompatibilityCommit.ok, false);
  assert.match(invalidCompatibilityCommit.label, /Registry deployment commit must be a full/i);

  assert.equal(validateFleetTargetConfiguration({}), null);
});
