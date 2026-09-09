const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createGoLiveRouter } = require("../src/routes/goLive");
const { requireAuth } = require("../src/middleware/requireAuth");

async function withServer(role, loadGate, callback) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = role ? { role } : null;
    next();
  });
  app.use("/api/go-live", createGoLiveRouter({ loadGate }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("requireAuth rejects an unauthenticated go-live request with 401", async () => {
  const req = { session: null };
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  await requireAuth(req, res, () => {
    nextCalled = true;
  });

  assert.equal(statusCode, 401);
  assert.match(body?.error || "", /not logged in/i);
  assert.equal(nextCalled, false);
});

test("go-live route rejects non-admin users with 403", async () => {
  let calls = 0;
  await withServer("staff", async () => {
    calls += 1;
    return { schemaVersion: 1, status: "ready", ready: true };
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/go-live`);
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /administrators/i);
  });
  assert.equal(calls, 0);
});

test("admin GET and POST execute the expected safe gate modes", async () => {
  const modes = [];
  await withServer("admin", async ({ runChecks, baseUrl }) => {
    modes.push({ runChecks, baseUrl });
    return {
      schemaVersion: 1,
      status: "ready",
      ready: true,
      decision: { status: "ready", handoverAllowed: true },
    };
  }, async (baseUrl) => {
    const getResponse = await fetch(`${baseUrl}/api/go-live`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).schemaVersion, 1);

    const postResponse = await fetch(`${baseUrl}/api/go-live/run`, { method: "POST" });
    assert.equal(postResponse.status, 200);
    assert.equal((await postResponse.json()).decision.handoverAllowed, true);
  });

  assert.deepEqual(modes.map((item) => item.runChecks), [false, true]);
  assert.equal(modes.every((item) => /^http:\/\/127\.0\.0\.1:\d+$/.test(item.baseUrl)), true);
});
