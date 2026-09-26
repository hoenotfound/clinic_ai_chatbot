const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deriveChannelReadiness,
  getCommentAutomationReadiness,
} = require("../src/services/commentAutomationReadinessService");

function overview(checks) {
  return {
    checkedAt: "2026-09-26T04:30:00.000Z",
    checks,
  };
}

test("reports not connected when the channel is not configured", () => {
  const result = deriveChannelReadiness(
    overview([
      {
        key: "facebook",
        configured: false,
        status: "not_configured",
        summary: "Optional integration is not configured.",
      },
      {
        key: "meta_webhook",
        configured: false,
        status: "not_configured",
      },
    ]),
    "facebook"
  );

  assert.equal(result.state, "not_connected");
  assert.equal(result.label, "Not connected");
});

test("reports setup needed when channel exists but signed Meta webhook is not ready", () => {
  const result = deriveChannelReadiness(
    overview([
      {
        key: "instagram",
        configured: true,
        status: "ready",
        summary: "Messaging confirmed by a received customer message.",
      },
      {
        key: "meta_webhook",
        configured: true,
        status: "warning",
        summary: "Configured. Waiting for the first valid signed webhook from Meta.",
      },
    ]),
    "instagram"
  );

  assert.equal(result.state, "setup_needed");
  assert.equal(result.label, "Setup needed");
});

test("reports ready only when both channel messaging and signed webhook evidence are ready", () => {
  const result = deriveChannelReadiness(
    overview([
      {
        key: "facebook",
        configured: true,
        status: "ready",
        summary: "Messaging confirmed.",
        lastActivityAt: "2026-09-26T04:20:00.000Z",
      },
      {
        key: "meta_webhook",
        configured: true,
        status: "ready",
        summary: "A valid signed webhook has been received.",
        lastWebhookAt: "2026-09-26T04:21:00.000Z",
      },
    ]),
    "facebook"
  );

  assert.equal(result.state, "ready");
  assert.equal(result.label, "Ready");
  assert.equal(result.channel.lastActivityAt, "2026-09-26T04:20:00.000Z");
  assert.equal(result.webhook.lastWebhookAt, "2026-09-26T04:21:00.000Z");
});

test("returns only the safe Facebook and Instagram readiness summary from Setup Status", async () => {
  const statusService = {
    getOverview: async ({ requestBaseUrl }) => {
      assert.equal(requestBaseUrl, "https://client.example");
      return overview([
        { key: "facebook", configured: true, status: "ready", summary: "Facebook ready." },
        { key: "instagram", configured: false, status: "not_configured", summary: "Instagram missing." },
        { key: "meta_webhook", configured: true, status: "ready", summary: "Webhook ready." },
        { key: "database", configured: true, status: "ready", summary: "DB ready." },
      ]);
    },
  };

  const result = await getCommentAutomationReadiness({
    requestBaseUrl: "https://client.example",
    statusService,
  });

  assert.equal(result.facebook.state, "ready");
  assert.equal(result.instagram.state, "not_connected");
  assert.match(result.note, /live comment test/i);
  assert.equal(Object.hasOwn(result, "checks"), false);
});
