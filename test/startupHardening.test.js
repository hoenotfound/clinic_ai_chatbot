const test = require("node:test");
const assert = require("node:assert/strict");

const packageJson = require("../package.json");
const {
  DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
  databasePoolOptions,
} = require("../src/db/db");
const {
  DEFAULT_STARTUP_DEADLINE_MS,
  startStartupWatchdog,
  startupWatchdogOptions,
} = require("../src/utils/startupWatchdog");

test("database pool uses a bounded startup connection timeout with an env override", () => {
  const defaults = databasePoolOptions({ DATABASE_URL: "postgresql://example" });
  assert.equal(defaults.connectionTimeoutMillis, DEFAULT_DATABASE_CONNECT_TIMEOUT_MS);

  const overridden = databasePoolOptions({
    DATABASE_URL: "postgresql://example",
    DATABASE_CONNECT_TIMEOUT_MS: "4321",
  });
  assert.equal(overridden.connectionTimeoutMillis, 4321);

  const invalid = databasePoolOptions({
    DATABASE_URL: "postgresql://example",
    DATABASE_CONNECT_TIMEOUT_MS: "not-a-number",
  });
  assert.equal(invalid.connectionTimeoutMillis, DEFAULT_DATABASE_CONNECT_TIMEOUT_MS);
});

test("startup watchdog has a bounded default deadline and reads Render's port", () => {
  const options = startupWatchdogOptions({ PORT: "10000" });
  assert.equal(options.port, 10000);
  assert.equal(options.deadlineMs, DEFAULT_STARTUP_DEADLINE_MS);

  const overridden = startupWatchdogOptions({
    PORT: "10000",
    STARTUP_DEADLINE_MS: "240000",
    STARTUP_WARNING_INTERVAL_MS: "30000",
  });
  assert.equal(overridden.deadlineMs, 240000);
  assert.equal(overridden.warningIntervalMs, 30000);
});

test("startup watchdog exits with a clear error once the deadline is exceeded", async () => {
  const scheduled = [];
  const errors = [];
  let nowMs = 0;
  let exitCode = null;

  startStartupWatchdog({
    env: {
      PORT: "10000",
      STARTUP_DEADLINE_MS: "100",
      STARTUP_PROBE_INTERVAL_MS: "10",
      STARTUP_WARNING_INTERVAL_MS: "20",
    },
    now: () => nowMs,
    probe: async () => false,
    log: () => {},
    error: (message) => errors.push(message),
    exit: (code) => {
      exitCode = code;
    },
    setTimeoutFn: (fn, ms) => {
      const token = { fn, ms, unref() {} };
      scheduled.push(token);
      return token;
    },
    clearTimeoutFn: () => {},
  });

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 10);

  nowMs = 100;
  await scheduled.shift().fn();

  assert.equal(exitCode, 1);
  assert.equal(scheduled.length, 0);
  assert.match(errors[0], /startup deadline exceeded/i);
  assert.match(errors[0], /port 10000/i);
});

test("startup watchdog clears itself once the web server is reachable", async () => {
  const scheduled = [];
  const logs = [];
  let nowMs = 0;
  let exitCode = null;
  let cleared = 0;

  startStartupWatchdog({
    env: {
      PORT: "10000",
      STARTUP_DEADLINE_MS: "1000",
      STARTUP_PROBE_INTERVAL_MS: "10",
    },
    now: () => nowMs,
    probe: async () => true,
    log: (message) => logs.push(message),
    error: () => {},
    exit: (code) => {
      exitCode = code;
    },
    setTimeoutFn: (fn, ms) => {
      const token = { fn, ms, unref() {} };
      scheduled.push(token);
      return token;
    },
    clearTimeoutFn: () => {
      cleared += 1;
    },
  });

  nowMs = 25;
  await scheduled.shift().fn();

  assert.equal(exitCode, null);
  assert.equal(scheduled.length, 0);
  assert.equal(cleared, 1);
  assert.ok(logs.some((message) => /accepting HTTP connections/i.test(message)));
});

test("production start arms the watchdog before other preload workers", () => {
  const start = packageJson.scripts.start;
  const watchdog = start.indexOf("startupWatchdogBootstrap.js");
  const scheduled = start.indexOf("scheduledMessageBootstrap.js");
  const enrichment = start.indexOf("metaAdsEnrichmentBootstrap.js");

  assert.ok(watchdog >= 0);
  assert.ok(watchdog < scheduled);
  assert.ok(scheduled < enrichment);
});
