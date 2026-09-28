const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dbSource = fs.readFileSync(path.join(__dirname, "../src/db/db.js"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

test("database bootstrap uses the versioned runner instead of replaying schema files directly", () => {
  assert.match(dbSource, /runMigrations\(pool(?:\s*,|\s*\))/);
  assert.doesNotMatch(dbSource, /readFileSync/);
  assert.doesNotMatch(dbSource, /schema\.sql/);
  assert.doesNotMatch(dbSource, /loginRateLimitSchema\.sql/);
});

test("port binds before migrations but readiness and workers wait for migrations", () => {
  const listenIndex = serverSource.indexOf("await listenHttpServer(app, { port: PORT })");
  const migrationIndex = serverSource.indexOf("await initSchema()");
  const recoveryIndex = serverSource.indexOf("startInboundProcessingRecovery({");
  const followUpIndex = serverSource.indexOf("startAutomatedFollowUps()");
  const readyIndex = serverSource.indexOf("startupReadiness.markReady()");

  assert.ok(listenIndex >= 0, "server must bind the Render port through the startup listener");
  assert.ok(migrationIndex > listenIndex, "migrations should run after the socket opens");
  assert.ok(recoveryIndex > migrationIndex, "inbound recovery must not start before migrations finish");
  assert.ok(followUpIndex > migrationIndex, "follow-up worker must not start before migrations finish");
  assert.ok(readyIndex > recoveryIndex, "service must not become ready before recovery workers start");
  assert.ok(readyIndex > followUpIndex, "service must not become ready before follow-up workers start");
  assert.match(
    serverSource,
    /app\.use\(startupReadiness\.requireReady\)/,
    "application traffic must stay gated until startup is ready"
  );
  assert.doesNotMatch(
    serverSource,
    /app\.listen\(PORT/,
    "server startup must use the explicit 0.0.0.0 listener helper"
  );
});
