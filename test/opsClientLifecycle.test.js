const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLIENT_LIFECYCLE_STATUSES,
  DEFAULT_NEW_CLIENT_LIFECYCLE,
  LEGACY_CLIENT_LIFECYCLE,
  lifecyclePolicy,
  normalizeClientLifecycle,
} = require("../src/ops/clientLifecycle");

test("client lifecycle supports setup, trial, live and paused", () => {
  assert.deepEqual(CLIENT_LIFECYCLE_STATUSES, ["setup", "trial", "live", "paused"]);
  assert.equal(DEFAULT_NEW_CLIENT_LIFECYCLE, "setup");
  assert.equal(LEGACY_CLIENT_LIFECYCLE, "live");
});

test("new lifecycle values default to setup while legacy presentation can fall back to live", () => {
  assert.equal(normalizeClientLifecycle(""), "setup");
  assert.equal(normalizeClientLifecycle(null, { fallback: LEGACY_CLIENT_LIFECYCLE }), "live");
  assert.equal(normalizeClientLifecycle(" TRIAL "), "trial");
});

test("only live clients receive background polling and paused clients reject manual refresh", () => {
  assert.deepEqual(lifecyclePolicy("setup"), {
    status: "setup",
    backgroundPollingEnabled: false,
    manualRefreshAllowed: true,
  });
  assert.deepEqual(lifecyclePolicy("trial"), {
    status: "trial",
    backgroundPollingEnabled: false,
    manualRefreshAllowed: true,
  });
  assert.deepEqual(lifecyclePolicy("live"), {
    status: "live",
    backgroundPollingEnabled: true,
    manualRefreshAllowed: true,
  });
  assert.deepEqual(lifecyclePolicy("paused"), {
    status: "paused",
    backgroundPollingEnabled: false,
    manualRefreshAllowed: false,
  });
});

test("invalid lifecycle values fail closed", () => {
  assert.throws(
    () => normalizeClientLifecycle("production"),
    (error) => error?.code === "OPS_CLIENT_LIFECYCLE_INVALID",
  );
});
