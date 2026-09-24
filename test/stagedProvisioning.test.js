const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildProvisioningReceipt,
  evaluateDeferredChannelReadiness,
  parseArgs,
} = require("../scripts/provisionClient");

test("provision-client parses the explicit staged onboarding flag", () => {
  const args = parseArgs([
    "--client", "neutro-sense-tcm",
    "--industry", "tcm_clinic",
    "--channels", "whatsapp,facebook,instagram",
    "--defer-channel-readiness",
    "--execute",
  ]);

  assert.equal(args.execute, true);
  assert.equal(args.deferChannelReadiness, true);
});

test("staged onboarding accepts channel-only readiness blockers", () => {
  const state = evaluateDeferredChannelReadiness({
    status: "needs_attention",
    verificationCompleted: true,
    blocking: [
      { key: "whatsapp", status: "not_configured" },
      { key: "whatsapp_round_trip_inbound", status: "missing" },
      { key: "facebook", status: "not_configured" },
      { key: "meta_webhook", status: "not_configured" },
      { key: "instagram_runtime", status: "not_configured" },
    ],
  }, ["whatsapp", "facebook", "instagram"]);

  assert.equal(state.acceptable, true);
  assert.equal(state.nonChannelBlockingCount, 0);
  assert.ok(state.pendingChannelCount > 0);
});

test("staged onboarding still fails when a core readiness blocker exists", () => {
  const state = evaluateDeferredChannelReadiness({
    status: "needs_attention",
    verificationCompleted: true,
    blocking: [
      { key: "whatsapp", status: "not_configured" },
      { key: "system_health_database", status: "error" },
    ],
  }, ["whatsapp"]);

  assert.equal(state.acceptable, false);
  assert.deepEqual(state.nonChannelBlockingKeys, ["system_health_database"]);
});

test("staged provisioning state is preserved in the secret-free receipt", () => {
  const receipt = buildProvisioningReceipt({
    clientSlug: "neutro-sense-tcm",
    industry: "tcm_clinic",
    requiredChannels: ["whatsapp", "facebook", "instagram"],
    channelReadinessDeferred: true,
    stagedReadiness: {
      acceptable: true,
      verificationCompleted: true,
      pendingChannelCount: 4,
      nonChannelBlockingCount: 0,
      pendingChannelKeys: ["whatsapp", "facebook", "instagram", "meta_webhook"],
      nonChannelBlockingKeys: [],
    },
    profileContract: {
      envKey: "INITIAL_BUSINESS_TYPE",
      value: "tcm_clinic",
      lockedOnFirstStartup: true,
    },
    neon: {},
    r2: null,
    render: {},
    runtimeFinalization: null,
    opsEnrollment: null,
    readiness: null,
  }, new Date("2026-09-24T00:00:00.000Z"));

  assert.equal(receipt.channelReadinessDeferred, true);
  assert.equal(receipt.stagedReadiness.acceptable, true);
  assert.deepEqual(receipt.stagedReadiness.nonChannelBlockingKeys, []);
});
