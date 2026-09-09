const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createFleetService,
  fleetStatus,
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
      deployment: { commitSha: "old" },
      readiness: { status: "ready", channelContract: { channels: ["whatsapp"] } },
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
  assert.equal(presented.tokenConfigured, true);
});

test("refresh failure records the error but keeps the last successful readiness snapshot", async () => {
  let state = client({
    lastSuccessAt: "2026-09-09T12:00:00.000Z",
    lastStatus: "ready",
    lastSnapshot: {
      readiness: { status: "ready", channelContract: { channels: ["whatsapp"] } },
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
  assert.equal(refreshed.status, "ready");
  assert.equal(refreshed.lastError, "network down");
});
