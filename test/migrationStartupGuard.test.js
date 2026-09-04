const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dbSource = fs.readFileSync(path.join(__dirname, "../src/db/db.js"), "utf8");
const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

test("database bootstrap uses the versioned runner instead of replaying schema files directly", () => {
  assert.match(dbSource, /runMigrations\(pool\)/);
  assert.doesNotMatch(dbSource, /readFileSync/);
  assert.doesNotMatch(dbSource, /schema\.sql/);
  assert.doesNotMatch(dbSource, /loginRateLimitSchema\.sql/);
});

test("migrations finish before the server listens or background workers start", () => {
  const migrationIndex = serverSource.indexOf("await initSchema()");
  const listenIndex = serverSource.indexOf("app.listen(PORT");
  const recoveryIndex = serverSource.indexOf("startInboundProcessingRecovery({");
  const followUpIndex = serverSource.indexOf("startAutomatedFollowUps()");

  assert.ok(migrationIndex >= 0, "server must await database migrations");
  assert.ok(listenIndex > migrationIndex, "server must not accept traffic before migrations finish");
  assert.ok(recoveryIndex > migrationIndex, "inbound recovery must not start before migrations finish");
  assert.ok(followUpIndex > migrationIndex, "follow-up worker must not start before migrations finish");
});
