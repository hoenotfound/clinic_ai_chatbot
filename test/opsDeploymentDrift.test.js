const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deploymentDriftSummary,
  driftForClient,
  resolveFleetTarget,
  sameCommit,
} = require("../src/ops/deploymentDrift");
const { createFleetService, presentClient } = require("../src/ops/fleetService");
const { clientDetailHtml, dashboardHtml } = require("../src/ops/dashboard");

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
    provisionedCommitSha: "provisioned",
    lastPollAt: "2026-09-11T00:00:00.000Z",
    lastSuccessAt: "2026-09-11T00:00:00.000Z",
    lastStatus: "ready",
    lastError: null,
    lastSnapshot: {
      schemaVersion: 1,
      client: { businessType: "home_renovation" },
      deployment: {
        commitSha: "observed",
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
    OPS_FLEET_TARGET_COMMIT: "target-sha",
    RENDER_GIT_COMMIT: "registry-sha",
  }), {
    commitSha: "target-sha",
    source: "configured",
  });

  assert.deepEqual(resolveFleetTarget({ RENDER_GIT_COMMIT: "registry-sha" }), {
    commitSha: "registry-sha",
    source: "registry_deployment",
  });
  assert.deepEqual(resolveFleetTarget({}), {
    commitSha: null,
    source: "unavailable",
  });
  assert.equal(sameCommit("ABCDEF", "abcdef"), true);
});

test("drift uses the last observed running commit, not provisioning metadata", () => {
  const target = { commitSha: "target", source: "configured" };
  const current = driftForClient(client({
    provisionedCommitSha: "older",
    lastSnapshot: { deployment: { commitSha: "TARGET" } },
  }), target);
  assert.equal(current.driftStatus, "current");
  assert.equal(current.changedSinceProvisioning, true);

  const drifted = driftForClient(client({
    provisionedCommitSha: "older",
    lastSnapshot: { deployment: { commitSha: "old-running" } },
  }), target);
  assert.equal(drifted.driftStatus, "drifted");

  const neverObserved = driftForClient(client({
    provisionedCommitSha: "target",
    lastSnapshot: null,
  }), target);
  assert.equal(neverObserved.driftStatus, "unknown");
  assert.equal(neverObserved.observedCommit, null);
  assert.equal(neverObserved.provisionedCommit, "target");
});

test("client presentation exposes target, observed and provisioning commits without changing readiness", () => {
  const presented = presentClient(client({
    provisionedCommitSha: "initial",
    lastSnapshot: {
      deployment: {
        commitSha: "running",
        appVersion: "2.3.4",
        startedAt: "2026-09-10T23:55:00.000Z",
      },
      readiness: { status: "ready", channelContract: { channels: ["whatsapp"] } },
    },
  }), {
    now: new Date("2026-09-11T00:05:00.000Z"),
    env: {
      OPS_FLEET_TARGET_COMMIT: "target",
      RENDER_GIT_COMMIT: "registry",
      OPS_CLIENT_TOKEN_ACME: "x".repeat(32),
    },
  });

  assert.equal(presented.status, "ready");
  assert.equal(presented.deployment.driftStatus, "drifted");
  assert.equal(presented.deployment.observedCommit, "running");
  assert.equal(presented.deployment.targetCommit, "target");
  assert.equal(presented.deployment.targetSource, "configured");
  assert.equal(presented.deployment.provisionedCommit, "initial");
  assert.equal(presented.deployment.changedSinceProvisioning, true);
  assert.equal(presented.deployment.registryCommit, "registry");
  assert.equal(presented.deployment.appVersion, "2.3.4");
  assert.equal(presented.deployment.lastObservedAt, "2026-09-11T00:00:00.000Z");
  assert.equal(presented.deployment.state, "different");
});

test("deployment summary counts exact target matches, drift and unknown observations", () => {
  const summary = deploymentDriftSummary([
    { deployment: { driftStatus: "current" } },
    { deployment: { driftStatus: "drifted" } },
    { deployment: { driftStatus: "drifted" } },
    { deployment: { driftStatus: "unknown" } },
  ], { commitSha: "target", source: "configured" });

  assert.deepEqual(summary, {
    total: 4,
    current: 1,
    drifted: 2,
    unknown: 1,
    targetCommit: "target",
    targetSource: "configured",
  });
});

test("fleet list exposes deployment summary and refresh-all still returns the complete fleet", async () => {
  const states = [
    client({
      clientSlug: "setup",
      displayName: "Setup",
      lifecycleStatus: "setup",
      tokenEnvKey: "OPS_CLIENT_TOKEN_SETUP",
      lastSnapshot: { deployment: { commitSha: "old" }, readiness: { status: "needs_testing" } },
      lastStatus: "needs_testing",
    }),
    client({
      clientSlug: "live",
      displayName: "Live",
      lifecycleStatus: "live",
      tokenEnvKey: "OPS_CLIENT_TOKEN_LIVE",
      lastSnapshot: { deployment: { commitSha: "old" }, readiness: { status: "ready" } },
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
            deployment: { commitSha: "target" },
            readiness: { status: "ready" },
          },
        };
      },
    },
    env: { OPS_FLEET_TARGET_COMMIT: "target" },
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

test("Ops dashboard renders read-only drift visibility without a deployment action", () => {
  const dashboard = dashboardHtml("nonce");
  const detail = clientDetailHtml("acme", "nonce");

  assert.match(dashboard, /Fleet target/);
  assert.match(dashboard, /Version current/);
  assert.match(dashboard, /Drifted/);
  assert.match(dashboard, /Version unknown/);
  assert.match(dashboard, /Exact commit comparison only\. Read-only visibility\./);
  assert.match(detail, /Deployment & version drift/);
  assert.match(detail, /Observed commit/);
  assert.match(detail, /Provisioned commit/);
  assert.match(detail, /Registry does not redeploy, upgrade, or change client configuration/);
  assert.doesNotMatch(detail, /\/api\/clients\/[^'"+]*\/deploy/);
});
