const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_ATTEMPTS_BY_SCOPE,
  WINDOW_MS,
  createLoginRateLimiter,
  extractClientIp,
  keysForRequest,
} = require("../src/middleware/loginRateLimit");

function request({ username = "Admin.User", socketIp = "10.0.0.9", forwardedFor } = {}) {
  return {
    body: { username },
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
    socket: { remoteAddress: socketIp },
  };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("Render rate limiting uses Render's real first forwarded client IP", () => {
  const req = request({
    socketIp: "10.20.30.40",
    forwardedFor: "203.0.113.8, 10.20.30.40",
  });
  assert.equal(extractClientIp(req, { RENDER: "true" }), "203.0.113.8");
});

test("non-Render deployments do not trust a client-supplied forwarded IP by default", () => {
  const req = request({
    socketIp: "198.51.100.7",
    forwardedFor: "1.2.3.4",
  });
  assert.equal(extractClientIp(req, {}), "198.51.100.7");
});

test("rate-limit keys cover IP, username and pair without storing raw identifiers", () => {
  const req = request({
    socketIp: "10.0.0.5",
    forwardedFor: "203.0.113.11",
    username: "Clinic.Admin",
  });
  const keys = keysForRequest(req, {
    RENDER: "true",
    SESSION_SECRET: "unit-test-secret",
  });

  assert.deepEqual(keys.map((key) => key.scope), ["ip", "username", "pair"]);
  for (const key of keys) {
    assert.match(key.keyHash, /^[a-f0-9]{64}$/);
    assert.equal(key.keyHash.includes("203.0.113.11"), false);
    assert.equal(key.keyHash.includes("clinic.admin"), false);
  }
});

test("middleware atomically reserves the current attempt and blocks max + 1", async () => {
  const now = Date.UTC(2026, 8, 4, 9, 0, 0);
  const repository = {
    async recordFailure() {
      return [
        {
          scope: "pair",
          failures: MAX_ATTEMPTS_BY_SCOPE.pair + 1,
          window_started_at: new Date(now - 60_000),
        },
      ];
    },
  };
  const limiter = createLoginRateLimiter({
    repository,
    env: { SESSION_SECRET: "test-secret" },
    now: () => now,
  });
  const res = response();
  let nextCalled = false;

  await limiter.loginRateLimit(request(), res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(Number(res.headers["Retry-After"]), (WINDOW_MS - 60_000) / 1000);
  assert.match(res.body.error, /Too many login attempts/);
});

test("parallel burst admits only the configured pair limit", async () => {
  const now = Date.UTC(2026, 8, 4, 9, 0, 0);
  let reservations = 0;
  const repository = {
    async recordFailure() {
      const failures = ++reservations;
      await new Promise((resolve) => setImmediate(resolve));
      return [
        {
          scope: "pair",
          failures,
          window_started_at: new Date(now),
        },
      ];
    },
  };
  const limiter = createLoginRateLimiter({
    repository,
    env: { SESSION_SECRET: "test-secret" },
    now: () => now,
  });
  let admitted = 0;

  await Promise.all(
    Array.from({ length: 20 }, async () => {
      const res = response();
      await limiter.loginRateLimit(request(), res, () => {
        admitted += 1;
      });
    })
  );

  assert.equal(reservations, 20);
  assert.equal(admitted, MAX_ATTEMPTS_BY_SCOPE.pair);
});

test("normal rejection is counted once and success rolls back only its own reservation", async () => {
  const calls = [];
  const now = Date.UTC(2026, 8, 4, 9, 0, 0);
  const repository = {
    async recordFailure(keys, options) {
      calls.push(["record", keys.map((key) => key.scope), options.windowSeconds]);
      return keys.map((key) => ({
        scope: key.scope,
        failures: 1,
        window_started_at: new Date(now),
      }));
    },
    async decrementKeys(keys) {
      calls.push(["decrement", keys.map((key) => key.scope)]);
      return keys.length;
    },
    async pruneExpired() {
      calls.push(["prune"]);
      return 0;
    },
  };
  const limiter = createLoginRateLimiter({
    repository,
    env: { SESSION_SECRET: "test-secret" },
    now: () => now,
  });
  const req = request();
  const res = response();

  await limiter.loginRateLimit(req, res, () => {});
  await limiter.recordFailedAttempt(req);
  await limiter.clearAttempts(req);

  assert.equal(calls.filter((call) => call[0] === "record").length, 1);
  assert.deepEqual(calls.find((call) => call[0] === "record").slice(0, 2), [
    "record",
    ["ip", "username", "pair"],
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "decrement"), [
    "decrement",
    ["ip", "username", "pair"],
  ]);
});

test("rate limiter fails closed if persistent reservation cannot be written", async () => {
  const limiter = createLoginRateLimiter({
    repository: {
      async recordFailure() {
        throw new Error("database unavailable");
      },
    },
    env: { SESSION_SECRET: "test-secret" },
  });
  const res = response();
  let nextCalled = false;

  const oldError = console.error;
  console.error = () => {};
  try {
    await limiter.loginRateLimit(request(), res, () => {
      nextCalled = true;
    });
  } finally {
    console.error = oldError;
  }

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /temporarily unavailable/i);
});
