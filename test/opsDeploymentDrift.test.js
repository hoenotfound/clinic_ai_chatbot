const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deploymentDriftSummary,
  driftForClient,
  isFullCommitSha,
  resolveFleetTarget,
  sameCommit,
} = require("../src/ops/deploymentDrift");
const { createFleetService, presentClient } = require("../src/ops/fleetService");
const { clientDetailHtml, dashboardHtml } = require("../src/ops/dashboard");
const { validateFleetTargetConfiguration } = require("../scripts/verifyOpsRegistry");

const SHA = Object.freeze({
  target: "a".repeat(40),
  registry: "b".repeat(40),
  observed: "c".repeat(40),
  provisioned: "d".repeat(40),
  older: "e".repeat(40),
  running: "f".repeat(40),
  initial: "1".repeat(40),
  old: "2".repeat(40),
});

function client(overrides = {}) {
  return {
    clientSlug: "acme",
    displayName: "Acme",
    baseUrl: "https://acme.example.com",
    industry: "home_renovation",
    purchasedChannels: ["whatsapp"],
    lifecycleStatus: "live",
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
    render: { serviceId: "srv-acme", serviceName: "da-chatbot-acme" },
    neon: { projectId: "neon-acme", projectName: "da-chatbot-acme" },
    provisionedCommitSha: SHA.provisioned,
    lastPollAt: "2026-09-11T00:00:00.000Z",
    lastSuccessAt: "2026-09-11T00:00:00.000Z",
    lastStatus: "ready",
    lastError: null,
    lastSnapshot: {
      schemaVersion: 1,
      client: { businessType: "home_renovation" },
      deployment: {
        commitSha: SHA.observed,
        appVersion: "1.0.0",
        startedAt: "2026-09-10T23:55:00.000Z",
      },
      readiness: {
        status: "ready",
        channelContract: { channels: ["whatsapp"] },
        channels: [{ channel: "whatsapp", ready: true }],
      },
    },
    ...overrides,
  };
}

test("fleet target can be pinned independently of the registry deployment", () => {
  assert.deepEqual(resolveFleetTarget({
    OPS_FLEET_TARGET_COMMIT: SHA.target,
    RENDER_GIT_COMMIT: SHA.registry,
  }), {
    commitSha: SHA.target,
    source: "configured",
    validity: "valid",
    error: null,
  });

  assert.deepEqual(resolveFleetTarget({ RENDER_GIT_COMMIT: SHA.registry }), {
    commitSha: SHA.registry,
    source: "registry_deployment",
    validity: "valid",
    error: null,
  });
  assert.deepEqual(resolveFleetTarget({}), {
    commitSha: null,
    source: "unavailable",
    validity: "unavailable",
    error: null,
  });
  assert.equal(sameCommit(SHA.target.toUpperCase(), SHA.target), true);
  assert.equal(isFullCommitSha(SHA.target), true);
  assert.equal(isFullCommitSha("a".repeat(64)), true);
});

test("invalid pinned target fails closed instead of falling back and creating false drift", () => {
  const target = resolveFleetTarget({
    OPS_FLEET_TARGET_COMMIT: "main",
    RENDER_GIT_COMMIT: SHA.registry,
  });

  assert.equal(target.commitSha, null);
  assert.equal(target.source, "configured");
  assert.equal(target.validity, "invalid");
  assert.match(target.error, /full 40- or 64-character hexadecimal Git commit SHA/i);

  const drift = driftForClient(client(), target);
  assert.equal(drift.driftStatus, "unknown");
  assert.equal(drift.driftReason, "target_invalid");
  assert.equal(drift.targetValidity, "invalid");
});

test("Ops preflight rejects a malformed pinned fleet target and accepts a full SHA", () => {
  const invalid = validateFleetTargetConfiguration({ OPS_FLEET_TARGET_COMMIT: "main" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.label, /full 40- or 64-character hexadecimal Git commit SHA/i);

  assert.deepEqual(validateFleetTargetConfiguration({ OPS_FLEET_TARGET_COMMIT: SHA.target }), {
    ok: true,
    label: "Pinned fleet target is a valid full Git commit SHA",
  });
  assert.equal(validateFleetTargetConfiguration({}), null);
});

test("drift uses the last observed running commit, not provisioning metadata", () => {
  const target = resolveFleetTarget({ OPS_FLEET_TARGET_COMMIT: SHA.target });
  const current = driftForClient(client({
    provisionedCommitSha: SHA.older,
    lastSnapshot: { deployment: { commitSha: SHA.target.toUpperCase() } },
  }), target);
  assert.equal(current.driftStatus, "current");
  assert.equal(current.driftReason, "matches_target");
  assert.equal(current.changedSinceProvisioning, true);

  const drifted = driftForClient(client({
    provisionedCommitSha: SHA.older,
    lastSnapshot: { deployment: { commitSha: SHA.old } },
  }), target);
  assert.equal(drifted.driftStatus, "drifted");
  assert.equal(drifted.driftReason, "differs_from_target");

  const neverObserved = driftForClient(client({
    provisionedCommitSha: SHA.target,
    lastSnapshot: null,
  }), target);
  assert.equal(neverObserved.driftStatus, "unknown");
  assert.equal(neverObserved.driftReason, "observation_unavailable");
  assert.equal(neverObserved.observedCommit, null);
  assert.equal(neverObserved.provisionedCommit, SHA.target);
});

test("malformed observed commit is Unknown rather than Drifted", () => {
  const target = resolveFleetTarget({ OPS_FLEET_TARGET_COMMIT: SHA.target });
  const drift = driftForClient(client({
    lastSnapshot: { deployment: { commitSha: "not-a-git-sha" } },
  }), target);

  assert.equal(drift.driftStatus, "unknown");
  assert.equal(drift.driftReason, "observation_invalid");
  assert.equal(drift.observedCommit, "not-a-git-sha");
  assert.equal(drift.observedCommitValid, false);
  assert.equal(drift.changedSinceProvisioning, null);
});

test("client presentation keeps legacy Registry comparison separate from pinned fleet target", () => {
  const presented = presentClient(client({
    provisionedCommitSha: SHA.initial,
    lastSnapshot: {
      deployment: {
        commitSha: SHA.registry,
        appVersion: "2.3.4",
        startedAt: "2026-09-10T23:55:00.000Z",
      },
      readiness: { status: "ready", channelContract: { channels: ["whatsapp"] } },
    },
  }), {
    now: new Date("2026-09-11T00:05:00.000Z"),
    env: {
      OPS_FLEET_TARGET_COMMIT: SHA.target,
      RENDER_GIT_COMMIT: SHA.registry,
      OPS_CLIENT_TOKEN_ACME: "x".repeat(32),
    },
  });

  assert.equal(presented.status, "ready");
  assert.equal(presented.deployment.driftStatus, "drifted");
  assert.equal(presented.deployment.driftReason, "differs_from_target");
  assert.equal(presented.deployment.observedCommit, SHA.registry);
  assert.equal(presented.deployment.targetCommit, SHA.target);
  assert.equal(presented.deployment.targetSource, "configured");
  assert.equal(presented.deployment.targetValidity, "valid");
  assert.equal(presented.deployment.provisionedCommit, SHA.initial);
  assert.equal(presented.deployment.changedSinceProvisioning, true);
  assert.equal(presented.deployment.registryCommit, SHA.registry);
  assert.equal(presented.deployment.appVersion, "2.3.4");
  assert.equal(presented.deployment.lastObservedAt, "2026-09-11T00:00:00.000Z");
  assert.equal(presented.deployment.state, "current");
  assert.equal(presented.deployment.deployedCommit, SHA.registry);
});

test("deployment summary counts exact target matches, drift and unknown observations", () => {
  const target = resolveFleetTarget({ OPS_FLEET_TARGET_COMMIT: SHA.target });
  const summary = deploymentDriftSummary([
    { deployment: { driftStatus: "current" } },
    { deployment: { driftStatus: "drifted" } },
    { deployment: { driftStatus: "drifted" } },
    { deployment: { driftStatus: "unknown" } },
  ], target);

  assert.deepEqual(summary, {
    total: 4,
    current: 1,
    drifted: 2,
    unknown: 1,
    targetCommit: SHA.target,
    targetSource: "configured",
    targetValidity: "valid",
    targetError: null,
  });
});

test("fleet list exposes deployment summary and refresh-all still returns the complete fleet", async () => {
  const states = [
    client({
      clientSlug: "setup",
      displayName: "Setup",
      lifecycleStatus: "setup",
      tokenEnvKey: "OPS_CLIENT_TOKEN_SETUP",
      lastSnapshot: { deployment: { commitSha: SHA.old }, readiness: { status: "needs_testing" } },
      lastStatus: "needs_testing",
    }),
    client({
      clientSlug: "live",
      displayName: "Live",
      lifecycleStatus: "live",
      tokenEnvKey: "OPS_CLIENT_TOKEN_LIVE",
      lastSnapshot: { deployment: { commitSha: SHA.old }, readiness: { status: "ready" } },
    }),
  ];
  const bySlug = new Map(states.map((item) => [item.clientSlug, item]));
  const polled = [];
  const repo = {
    listClients: async () => states,
    getClient: async (slug) => bySlug.get(slug) || null,
    recordPollFailure: async () => {},
    recordPollSuccess: async (slug, values) => {
      const current = bySlug.get(slug);
      Object.assign(current, {
        lastPollAt: values.polledAt,
        lastSuccessAt: values.polledAt,
        lastStatus: values.snapshot.readiness.status,
        lastSnapshot: values.snapshot,
        lastError: null,
      });
    },
  };
  const fleet = createFleetService({
    repo,
    poller: {
      pollClient: async (item) => {
        polled.push(item.clientSlug);
        return {
          httpStatus: 200,
          snapshot: {
            schemaVersion: 1,
            deployment: { commitSha: SHA.target },
            readiness: { status: "ready" },
          },
        };
      },
    },
    env: { OPS_FLEET_TARGET_COMMIT: SHA.target },
    now: () => new Date("2026-09-11T00:05:00.000Z"),
  });

  const before = await fleet.listFleet();
  assert.equal(before.deploymentSummary.total, 2);
  assert.equal(before.deploymentSummary.drifted, 2);

  const result = await fleet.refreshAll();
  assert.deepEqual(polled, ["live"]);
  assert.equal(result.refreshedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.clients.length, 2);
  assert.equal(result.summary.total, 2);
  assert.equal(result.deploymentSummary.total, 2);
  assert.equal(result.deploymentSummary.current, 1);
  assert.equal(result.deploymentSummary.drifted, 1);
});

test("Ops dashboard clearly labels observational evidence and remains read-only", () => {
  const dashboard = dashboardHtml("nonce");
  const detail = clientDetailHtml("acme", "nonce");

  assert.match(dashboard, /Fleet target/);
  assert.match(dashboard, /Observed current/);
  assert.match(dashboard, /Observed drifted/);
  assert.match(dashboard, /Version unknown/);
  assert.match(dashboard, /Exact full-SHA comparison only\. Read-only visibility\./);
  assert.match(dashboard, /Fleet target invalid/);
  assert.match(detail, /Deployment & version drift/);
  assert.match(detail, /Observed commit/);
  assert.match(detail, /Target validation/);
  assert.match(detail, /Provisioned commit/);
  assert.match(detail, /Setup\/Trial clients are not background-polled/);
  assert.match(detail, /Registry does not redeploy, upgrade, or change client configuration/);
  assert.doesNotMatch(detail, /\/api\/clients\/[^'"+]*\/deploy/);
});
