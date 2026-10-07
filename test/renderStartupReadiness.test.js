const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const startupReadiness = require("../src/services/startupReadinessService");
const {
  closeHttpServer,
  listenHttpServer,
} = require("../src/services/httpServerStartup");

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

test.beforeEach(() => {
  startupReadiness.resetForTests();
});

test("readiness stays unhealthy until startup is explicitly complete", () => {
  const before = responseRecorder();
  startupReadiness.readinessHandler({}, before);
  assert.equal(before.statusCode, 503);
  assert.deepEqual(before.body, { status: "starting", ready: false });

  const rootBefore = responseRecorder();
  startupReadiness.rootReadinessHandler({}, rootBefore);
  assert.equal(rootBefore.statusCode, 503);
  assert.equal(rootBefore.body, "AI messaging bot is starting.");

  startupReadiness.markReady(new Date("2026-09-28T11:30:00.000Z"));

  const after = responseRecorder();
  startupReadiness.readinessHandler({}, after);
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.body, { status: "ready", ready: true });

  const rootAfter = responseRecorder();
  startupReadiness.rootReadinessHandler({}, rootAfter);
  assert.equal(rootAfter.statusCode, 200);
  assert.equal(rootAfter.body, "AI messaging bot is running.");
});

test("liveness is healthy while readiness is still starting", () => {
  const res = responseRecorder();
  startupReadiness.livenessHandler({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: "alive" });
});

test("application traffic is blocked until startup becomes ready", () => {
  let nextCalls = 0;

  const blocked = responseRecorder();
  startupReadiness.requireReady({}, blocked, () => {
    nextCalls += 1;
  });
  assert.equal(blocked.statusCode, 503);
  assert.deepEqual(blocked.body, {
    error: "Service is starting.",
    code: "service_starting",
  });
  assert.equal(nextCalls, 0);

  startupReadiness.markReady();
  const allowed = responseRecorder();
  startupReadiness.requireReady({}, allowed, () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
});

test("failed startup remains unready without exposing the startup error", () => {
  startupReadiness.markFailed(new Date("2026-09-28T11:31:00.000Z"));

  const ready = responseRecorder();
  startupReadiness.readinessHandler({}, ready);
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.body, { status: "failed", ready: false });

  const traffic = responseRecorder();
  startupReadiness.requireReady({}, traffic, () => {
    throw new Error("must not run");
  });
  assert.equal(traffic.statusCode, 503);
  assert.deepEqual(traffic.body, {
    error: "Service startup failed.",
    code: "service_startup_failed",
  });
});

test("HTTP listener binds on 0.0.0.0 and can accept a local request", async () => {
  const app = express();
  app.get("/", (_req, res) => res.send("ok"));

  const server = await listenHttpServer(app, {
    port: 0,
    host: "0.0.0.0",
    log() {},
  });

  try {
    const address = server.address();
    assert.equal(address.address, "0.0.0.0");
    assert.ok(address.port > 0);

    const body = await new Promise((resolve, reject) => {
      http.get(
        { host: "127.0.0.1", port: address.port, path: "/" },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => resolve(data));
        }
      ).on("error", reject);
    });
    assert.equal(body, "ok");
  } finally {
    await closeHttpServer(server);
  }
});

test("startup schedules R2 temp cleanup without running an immediate sweep", () => {
  const startupSource = fs.readFileSync(
    path.join(__dirname, "../src/services/applicationStartup.js"),
    "utf8"
  );

  const workerBlockStart = startupSource.indexOf(
    'console.log("[Startup] Starting maintenance and recovery workers...")'
  );
  const workerBlockEnd = startupSource.indexOf(
    "startInboundProcessingRecovery",
    workerBlockStart
  );
  const workerBlock = startupSource.slice(workerBlockStart, workerBlockEnd);

  assert.match(workerBlock, /setIntervalFn\(\s*pruneStaleTemporaryMediaSafely/);
  assert.match(
    startupSource,
    /pruneStaleFollowUpConfigVideos\(\{[\s\S]*referencedKeys:\s*configuredFollowUpVideoKeys\(\)/
  );
  assert.doesNotMatch(
    workerBlock,
    /(?:^|\n)\s*pruneStaleTemporaryMediaSafely\(\);/
  );
  assert.doesNotMatch(
    workerBlock,
    /(?:^|\n)\s*mediaStorage\.pruneStaleFollowUpConfigVideos\(/
  );
});

test("application startup opens the Render port before initialization and marks ready last", () => {
  const startupSource = fs.readFileSync(
    path.join(__dirname, "../src/services/applicationStartup.js"),
    "utf8"
  );
  const appSource = fs.readFileSync(
    path.join(__dirname, "../src/createApp.js"),
    "utf8"
  );

  const listenAt = startupSource.indexOf("await listenHttpServer(app, { port })");
  const initAt = startupSource.indexOf("await initSchema()");
  const telegramWorkerAt = startupSource.indexOf("startTelegramImmediateAlertRecovery()");
  const workersAt = startupSource.indexOf('console.log("[Startup] Maintenance and recovery workers started.")');
  const readyAt = startupSource.indexOf("startupReadiness.markReady()");

  assert.ok(listenAt >= 0, "startup module should open through listenHttpServer");
  assert.ok(initAt > listenAt, "database initialization must happen after the port is bound");
  assert.ok(telegramWorkerAt > initAt, "Telegram recovery must start only after database migrations");
  assert.ok(workersAt > telegramWorkerAt, "worker startup log should follow Telegram recovery startup");
  assert.ok(readyAt > workersAt, "readiness must only turn green after worker startup");
  assert.match(appSource, /app\.get\("\/health\/live", startupReadiness\.livenessHandler\)/);
  assert.match(appSource, /app\.get\("\/health\/ready", startupReadiness\.readinessHandler\)/);
  assert.match(appSource, /app\.use\(startupReadiness\.requireReady\)/);
});
