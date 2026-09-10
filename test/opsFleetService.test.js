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
    lifecycleStatus: "live",
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
  assert.equal(presented.lifecycleStatus, "live");
  assert.equal(presented.backgroundPollingEnabled, true);
  assert.equal(presented.manualRefreshAllowed, true);
});

test("setup/trial clients keep their last known readiness while intentionally not background-polled", () => {
  for (const lifecycleStatus of ["setup", "trial", "paused"]) {
    const presented = presentClient(client({
      lifecycleStatus,
      lastPollAt: "2026-09-01T12:00:00.000Z",
      lastSuccessAt: "2026-09-01T12:00:00.000Z",
      lastStatus: "needs_testing",
      lastSnapshot: { schemaVersion: 1, readiness: { status: "needs_testing" } },
    }), {
      now: new Date("2026-09-10T12:00:00.000Z"),
      offlineAfterMs: 15 * 60 * 1000,
    });
    assert.equal(presented.status, "needs_testing");
    assert.equal(presented.backgroundPollingEnabled, false);
  }
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

test("concurrent refreshes for the same client share one poll", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let state = client();
  const snapshot = { schemaVersion: 1, readiness: { status: "ready" } };
  const repo = {
    listClients: async () => [state],
    getClient: async () => state,
    recordPollFailure: async () => {},
    recordPollSuccess: async (_slug, values) => {
      state = {
        ...state,
        lastPollAt: values.polledAt,
        lastSuccessAt: values.polledAt,
        lastStatus: "ready",
        lastSnapshot: snapshot,
        lastError: null,
      };
    },
  };
  const fleet = createFleetService({
    repo,
    poller: {
      pollClient: async () => {
        calls += 1;
        await gate;
        return { httpStatus: 200, snapshot };
      },
    },
    now: () => new Date("2026-09-09T12:06:00.000Z"),
  });

  const first = fleet.refreshClient("acme");
  const second = fleet.refreshClient("acme");
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(fleet.activeClientRefreshCount(), 1);
  release();
  await first;
  assert.equal(fleet.activeClientRefreshCount(), 0);
});

test("cancelled background poll does not record a client failure", async () => {
  let failureWrites = 0;
  const state = client({
    lastPollAt: "2026-09-09T12:00:00.000Z",
    lastSuccessAt: "2026-09-09T12:00:00.000Z",
    lastStatus: "ready",
    lastSnapshot: { schemaVersion: 1, readiness: { status: "ready" } },
  });
  const repo = {
    listClients: async () => [state],
    getClient: async () => state,
    recordPollSuccess: async () => {},
    recordPollFailure: async () => { failureWrites += 1; },
  };
  const cancelled = Object.assign(new Error("cancelled"), { code: "OPS_POLL_CANCELLED" });
  const fleet = createFleetService({
    repo,
    poller: { pollClient: async () => { throw cancelled; } },
    now: () => new Date("2026-09-09T12:06:00.000Z"),
  });

  const refreshed = await fleet.refreshClient("acme");
  assert.equal(failureWrites, 0);
  assert.equal(refreshed.status, "ready");
});

test("refreshAll polls only live clients and leaves setup/trial/paused deployments asleep", async () => {
  const now = "2026-09-10T12:00:00.000Z";
  const clients = [
    client({ clientSlug: "setup", lifecycleStatus: "setup", lastSuccessAt: now, lastStatus: "needs_testing" }),
    client({ clientSlug: "trial", lifecycleStatus: "trial", lastSuccessAt: now, lastStatus: "needs_testing" }),
    client({ clientSlug: "live", lifecycleStatus: "live", lastSuccessAt: now, lastStatus: "ready" }),
    client({ clientSlug: "paused", lifecycleStatus: "paused", lastSuccessAt: now, lastStatus: "ready" }),
  ];
  const bySlug = new Map(clients.map((item) => [item.clientSlug, item]));
  const polled = [];
  const repo = {
    listClients: async () => clients,
    getClient: async (slug) => bySlug.get(slug),
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
        return { httpStatus: 200, snapshot: { schemaVersion: 1, readiness: { status: "ready" } } };
      },
    },
    now: () => new Date(now),
  });

  const result = await fleet.refreshAll();
  assert.deepEqual(polled, ["live"]);
  assert.equal(result.refreshedCount, 1);
  assert.equal(result.skippedCount, 3);
});

test("setup and trial clients allow manual refresh while paused clients fail closed", async () => {
  for (const lifecycleStatus of ["setup", "trial"]) {
    let state = client({ lifecycleStatus });
    let polls = 0;
    const repo = {
      listClients: async () => [state],
      getClient: async () => state,
      recordPollFailure: async () => {},
      recordPollSuccess: async (_slug, values) => {
        state = {
          ...state,
          lastPollAt: values.polledAt,
          lastSuccessAt: values.polledAt,
          lastStatus: "ready",
          lastSnapshot: values.snapshot,
        };
      },
    };
    const fleet = createFleetService({
      repo,
      poller: {
        pollClient: async () => {
          polls += 1;
          return { httpStatus: 200, snapshot: { schemaVersion: 1, readiness: { status: "ready" } } };
        },
      },
    });
    await fleet.refreshClient("acme");
    assert.equal(polls, 1);
  }

  const paused = client({ lifecycleStatus: "paused" });
  const fleet = createFleetService({
    repo: {
      listClients: async () => [paused],
      getClient: async () => paused,
      recordPollFailure: async () => {},
      recordPollSuccess: async () => {},
    },
    poller: { pollClient: async () => { throw new Error("should not poll"); } },
  });
  await assert.rejects(
    fleet.refreshClient("acme"),
    (error) => error?.code === "OPS_CLIENT_PAUSED",
  );
});

test("lifecycle updates are persisted through the repository and returned in presentation", async () => {
  let state = client({ lifecycleStatus: "setup" });
  const repo = {
    listClients: async () => [state],
    getClient: async () => state,
    updateLifecycle: async (_slug, lifecycleStatus) => {
      state = { ...state, lifecycleStatus };
      return state;
    },
  };
  const fleet = createFleetService({ repo, poller: {} });
  const updated = await fleet.setClientLifecycle("acme", "trial");
  assert.equal(updated.lifecycleStatus, "trial");
  assert.equal(updated.backgroundPollingEnabled, false);
  assert.equal(updated.manualRefreshAllowed, true);

  await assert.rejects(
    fleet.setClientLifecycle("acme", "production"),
    (error) => error?.code === "OPS_CLIENT_LIFECYCLE_INVALID",
  );
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
