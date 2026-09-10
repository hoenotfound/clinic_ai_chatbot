const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  createRequireOpsReadinessToken,
} = require("../src/middleware/requireOpsReadinessToken");
const {
  sanitizeGateForOps,
} = require("../src/services/opsReadinessService");
const {
  createOpsReadinessRouter,
} = require("../src/routes/opsReadiness");

function gate() {
  return {
    status: "ready",
    ready: true,
    checkedAt: "2026-09-09T12:00:00.000Z",
    lastTechnicalRunAt: "2026-09-09T11:59:00.000Z",
    businessName: "Acme",
    businessType: "home_renovation",
    profileAlignment: {
      ready: true,
      expectedIndustry: "home_renovation",
      actualIndustry: "home_renovation",
      summary: "Aligned",
    },
    businessSetup: { ready: true, completed: 6, total: 6 },
    channelContract: { configured: true, channels: ["whatsapp"], error: null },
    channels: [{
      channel: "whatsapp",
      label: "WhatsApp",
      purchased: true,
      configured: true,
      runtimeReady: true,
      inboundVerified: true,
      aiReplyVerified: true,
      ready: true,
      verificationState: "ready",
      latestCustomerInboundAt: "2026-09-09T11:55:00.000Z",
      lastVerifiedRoundTripInboundAt: "2026-09-09T11:50:00.000Z",
      lastVerifiedAutomatedReplyAt: "2026-09-09T11:50:03.000Z",
      lastReadinessDeliveryFailureAt: null,
      checks: [{ secret: "must not leak" }],
    }, {
      channel: "facebook",
      label: "Facebook",
      purchased: false,
      configured: true,
      ready: true,
      checks: [{ secret: "must not leak" }],
    }],
    blockers: [],
    testingRequired: [],
    warnings: [],
    summary: {
      blockers: 0,
      testingRequired: 0,
      warnings: 0,
      purchasedChannels: 1,
      channelsReady: 1,
    },
    customer: { phone: "+60123456789", message: "private lead message" },
    credentials: {
      databaseUrl: "postgresql://secret",
      metaAccessToken: "meta-secret",
      geminiApiKey: "gemini-secret",
      adminPassword: "admin-secret",
    },
    system: { health: { internal: "must not leak" } },
  };
}

test("ops readiness snapshot is sanitized and contains purchased operational data only", () => {
  const snapshot = sanitizeGateForOps(gate(), {
    CLIENT_SLUG: "acme",
    RENDER_GIT_COMMIT: "abcdef123456",
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.client.slug, "acme");
  assert.equal(snapshot.deployment.commitSha, "abcdef123456");
  assert.equal(snapshot.readiness.status, "ready");
  assert.deepEqual(snapshot.readiness.channels.map((item) => item.channel), ["whatsapp"]);
  assert.equal(snapshot.readiness.channels[0].ready, true);
  assert.equal(snapshot.readiness.channels[0].lastVerifiedRoundTripAt, "2026-09-09T11:50:00.000Z");
  assert.equal(Object.hasOwn(snapshot.readiness.channels[0], "checks"), false);
  assert.equal(Object.hasOwn(snapshot, "system"), false);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /must not leak|private lead message|\+60123456789|postgresql:\/\/secret|meta-secret|gemini-secret|admin-secret/,
  );
});

test("ops readiness token middleware is disabled by default", () => {
  const middleware = createRequireOpsReadinessToken({ env: {} });
  const req = { get: () => "" };
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  middleware(req, response, () => assert.fail("must not call next"));
  assert.equal(response.statusCode, 404);
});

test("ops readiness token rejects an invalid bearer token", () => {
  const middleware = createRequireOpsReadinessToken({ env: { OPS_READINESS_TOKEN: "x".repeat(32) } });
  const req = { get: () => `Bearer ${"y".repeat(32)}` };
  const response = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    set() {},
    json() { return this; },
  };
  middleware(req, response, () => assert.fail("must not call next"));
  assert.equal(response.statusCode, 401);
});

test("ops readiness token accepts only the configured bearer token", () => {
  const env = { OPS_READINESS_TOKEN: "x".repeat(32) };
  const middleware = createRequireOpsReadinessToken({ env });
  let nextCalled = false;
  const req = { get: () => `Bearer ${"x".repeat(32)}` };
  const response = {
    set() {},
    status() { return this; },
    json() { return this; },
  };
  middleware(req, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

async function withServer(callback) {
  const app = express();
  app.use("/api/ops/readiness", createOpsReadinessRouter({
    authenticate: (_req, _res, next) => next(),
    loadReadiness: async () => ({ schemaVersion: 1, source: "da-chatbot", readiness: { status: "ready" } }),
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("ops readiness route is GET-only and returns the machine snapshot", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ops/readiness`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schemaVersion, 1);
    assert.equal((await fetch(`${baseUrl}/api/ops/readiness`, { method: "POST" })).status, 404);
  });
});
