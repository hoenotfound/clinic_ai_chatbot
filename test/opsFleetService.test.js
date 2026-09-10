const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFleetService,
  fleetStatus,
  fleetSummary,
  presentClient,
} = require("../src/ops/fleetService");

function client(overrides = {}) {
  return {
    clientSlug: "acme",
    displayName: "Acme",
    baseUrl: "https://acme.example.com",
    industry: "home_renovation",
    purchasedChannels: ["whatsapp"],
    tokenEnvKey: "OPS_CLIENT_TOKEN_ACME",
    render: { serviceId: "srv-1", serviceName: "acme" },
    neon: { projectId: "neon-1", projectName: "acme" },
    provisionedCommitSha: "abc",
    lastPollAt: null,
    lastSuccessAt: null,
    lastStatus: null,
    lastSnapshot: null,
    lastError: null,
    ...overrides,
  };
}

test("client becomes offline when it has never been successfully polled", () => {
  assert.equal(fleetStatus(client()), "offline");
});

test("fleet presentation reports version drift without GitHub access", () => {
  const presented = presentClient(client({
    lastSuccessAt: "2026-09-09T12:00:00.000Z",
    lastStatus: "ready",
    lastSnapshot: {
      deployment: { commitSha: "old", appVersion: "0.1.0" },
      readiness: {
        status: "ready",
        channelContract: { channels: ["whatsapp"] },
        channels: [{ channel: "whatsapp", ready: true }],
      },
      client: { businessType: "home_renovation" },
    },
  }), {
    now: new Date("2026-09-09T12:05:00.000Z"),
    env: {
      RENDER_GIT_COMMIT: "current",
      OPS_CLIENT_TOKEN_ACME: "x".repeat(32),
    },
  });
  assert.equal(presented.status, "ready");
  assert.equal(presented.deployment.state, "different");
  assert.equal(presented.deployment.appVersion, "0.1.0");
  assert.equal(presented.channels[0].channel, "whatsapp");
  assert.equal(presented.tokenConfigured, true);
});

test("refresh failure marks current connectivity offline but keeps last successful readiness", async () => {
  let state = client({
    lastPollAt: "2026-09-09T12:00:00.000Z",
    lastSuccessAt: "2026-09-09T12:00:00.000Z",
    lastStatus: "ready",
    lastSnapshot: {
      readiness: {
        status: "ready",
        channelContract: { channels: ["whatsapp"] },
        channels: [{ channel: "whatsapp", ready: true }],
      },
      client: { businessType: "home_renovation" },
      deployment: { commitSha: "abc" },
    },
  });
  const repo = {
    listClients: async () => [state],
    getClient: async () => state,
    recordPollFailure: async (_slug, values) => {
      state = { ...state, lastPollAt: values.polledAt, lastError: values.error };
    },
    recordPollSuccess: async () => {},
  };
  const fleet = createFleetService({
    repo,
    poller: { pollClient: async () => { throw new Error("network down"); } },
    now: () => new Date("2026-09-09T12:06:00.000Z"),
  });

  const refreshed = await fleet.refreshClient("acme");
  assert.equal(refreshed.status, "offline");
  assert.equal(refreshed.online, false);
  assert.equal(refreshed.lastKnownReadinessStatus, "ready");
  assert.equal(refreshed.readiness.status, "ready");
  assert.equal(refreshed.lastError, "network down");
});

test("successful refresh updates last success and clears the current connectivity problem", async () => {
  let state = client({ lastError: "old failure" });
  const polledAt = new Date("2026-09-09T12:06:00.000Z");
  const snapshot = {
    schemaVersion: 1,
    readiness: { status: "ready_with_warnings", channelContract: { channels: ["whatsapp"] } },
  };
  const repo = {
    listClients: async () => [state],
    getClient: async () => state,
    recordPollFailure: async () => {},
    recordPollSuccess: async (_slug, values) => {
      state = {
        ...state,
        lastPollAt: values.polledAt,
        lastSuccessAt: values.polledAt,
        lastStatus: values.snapshot.readiness.status,
        lastSnapshot: values.snapshot,
        lastError: null,
      };
    },
  };
  const fleet = createFleetService({
    repo,
    poller: { pollClient: async () => ({ httpStatus: 200, snapshot }) },
    now: () => polledAt,
  });

  const refreshed = await fleet.refreshClient("acme");
  assert.equal(refreshed.status, "ready_with_warnings");
  assert.equal(refreshed.lastSuccessAt, polledAt);
  assert.equal(refreshed.lastError, null);
});

test("refreshAll isolates a failed client and returns all five summary states", async () => {
  const now = "2026-09-09T12:06:00.000Z";
  const clients = [
    client({ clientSlug: "ready", lastSuccessAt: now, lastStatus: "ready" }),
    client({ clientSlug: "warning", lastSuccessAt: now, lastStatus: "ready_with_warnings" }),
    client({ clientSlug: "testing", lastSuccessAt: now, lastStatus: "needs_testing" }),
    client({ clientSlug: "blocked", lastSuccessAt: now, lastStatus: "blocked" }),
    client({ clientSlug: "broken", lastSuccessAt: now, lastStatus: "ready" }),
  ];
  const bySlug = new Map(clients.map((item) => [item.clientSlug, item]));
  const repo = {
    listClients: async () => clients,
    getClient: async (slug) => bySlug.get(slug),
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
    recordPollFailure: async (slug, values) => {
      const current = bySlug.get(slug);
      Object.assign(current, { lastPollAt: values.polledAt, lastError: values.error });
    },
  };
  const statusBySlug = {
    ready: "ready",
    warning: "ready_with_warnings",
    testing: "needs_testing",
    blocked: "blocked",
  };
  const poller = {
    pollClient: async (item) => {
      if (item.clientSlug === "broken") throw new Error("unreachable");
      return {
        httpStatus: 200,
        snapshot: { schemaVersion: 1, readiness: { status: statusBySlug[item.clientSlug] } },
      };
    },
  };
  const fleet = createFleetService({ repo, poller, now: () => new Date(now) });
  const result = await fleet.refreshAll();

  assert.deepEqual(result.summary, {
    total: 5,
    ready: 1,
    ready_with_warnings: 1,
    needs_testing: 1,
    blocked: 1,
    offline: 1,
  });
  assert.equal(result.clients.find((item) => item.clientSlug === "broken").lastKnownReadinessStatus, "ready");
});

test("fleetSummary counts unknown presentation states as offline", () => {
  assert.deepEqual(fleetSummary([
    { status: "ready" },
    { status: "ready_with_warnings" },
    { status: "needs_testing" },
    { status: "blocked" },
    { status: "offline" },
    { status: "something_new" },
  ]), {
    total: 6,
    ready: 1,
    ready_with_warnings: 1,
    needs_testing: 1,
    blocked: 1,
    offline: 2,
  });
});
