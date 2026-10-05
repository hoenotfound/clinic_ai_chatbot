const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dbSource = fs.readFileSync(path.join(__dirname, "../src/db/db.js"), "utf8");
const startupSource = fs.readFileSync(
  path.join(__dirname, "../src/services/applicationStartup.js"),
  "utf8"
);
const appSource = fs.readFileSync(path.join(__dirname, "../src/createApp.js"), "utf8");
const scheduledRepoSource = fs.readFileSync(
  path.join(__dirname, "../src/db/scheduledMessageRepo.js"),
  "utf8"
);
const migration021Source = fs.readFileSync(
  path.join(__dirname, "../src/db/migrations/021_reliability_review_followups.sql"),
  "utf8"
);
const migration022Source = fs.readFileSync(
  path.join(__dirname, "../src/db/migrations/022_cancelled_outbound_attempt_durability.sql"),
  "utf8"
);
const migration031Source = fs.readFileSync(
  path.join(__dirname, "../src/db/migrations/031_follow_up_targeting_analytics.sql"),
  "utf8"
);
const migration033Source = fs.readFileSync(
  path.join(__dirname, "../src/db/migrations/033_follow_up_ai_decisions.sql"),
  "utf8"
);

test("database bootstrap uses the versioned runner instead of replaying schema files directly", () => {
  assert.match(dbSource, /runMigrations\(pool(?:\s*,|\s*\))/);
  assert.doesNotMatch(dbSource, /readFileSync/);
  assert.doesNotMatch(dbSource, /schema\.sql/);
  assert.doesNotMatch(dbSource, /loginRateLimitSchema\.sql/);
});

test("port binds before migrations but readiness and workers wait for migrations", () => {
  const listenIndex = startupSource.indexOf("await listenHttpServer(app, { port })");
  const migrationIndex = startupSource.indexOf("await initSchema()");
  const recoveryIndex = startupSource.indexOf("startInboundProcessingRecovery({");
  const scheduledIndex = startupSource.indexOf("startScheduledMessageWorker()");
  const followUpIndex = startupSource.indexOf("startAutomatedFollowUps()");
  const readyIndex = startupSource.indexOf("startupReadiness.markReady()");

  assert.ok(listenIndex >= 0, "server must bind the Render port through the startup listener");
  assert.ok(migrationIndex > listenIndex, "migrations should run after the socket opens");
  assert.ok(recoveryIndex > migrationIndex, "inbound recovery must not start before migrations finish");
  assert.ok(scheduledIndex > migrationIndex, "scheduled-message worker must not start before migrations finish");
  assert.ok(followUpIndex > migrationIndex, "follow-up worker must not start before migrations finish");
  assert.ok(readyIndex > recoveryIndex, "service must not become ready before recovery workers start");
  assert.ok(readyIndex > scheduledIndex, "service must not become ready before scheduled-message worker starts");
  assert.ok(readyIndex > followUpIndex, "service must not become ready before follow-up workers start");
  assert.match(
    appSource,
    /app\.use\(startupReadiness\.requireReady\)/,
    "application traffic must stay gated until startup is ready"
  );
  assert.doesNotMatch(
    startupSource,
    /app\.listen\(/,
    "server startup must use the explicit 0.0.0.0 listener helper"
  );
});


test("scheduled-message schema is versioned instead of created by the runtime repository", () => {
  assert.doesNotMatch(scheduledRepoSource, /CREATE TABLE/i);
  assert.doesNotMatch(scheduledRepoSource, /ensureSchema/);
  assert.match(migration021Source, /CREATE TABLE IF NOT EXISTS scheduled_messages/i);
  assert.match(migration021Source, /CREATE TABLE IF NOT EXISTS inbound_outbound_attempts/i);
  assert.match(
    migration022Source,
    /assistant_message_id[\s\S]*ON DELETE SET NULL/i,
    "cancelled outbound attempts must survive deletion of their unsent assistant row"
  );
});


test("follow-up targeting analytics metadata is forward-migrated", () => {
  assert.match(
    migration031Source,
    /ADD COLUMN IF NOT EXISTS automated_follow_up_target_service TEXT/i
  );
  assert.match(
    migration031Source,
    /ADD COLUMN IF NOT EXISTS automated_follow_up_targeting_recorded BOOLEAN NOT NULL DEFAULT false/i
  );
  assert.match(
    migration031Source,
    /automated_follow_up_for_message_id IS NOT NULL/i
  );
});


test("AI follow-up terminal decisions are forward-migrated durably", () => {
  assert.match(
    migration033Source,
    /CREATE TABLE IF NOT EXISTS follow_up_ai_decisions/i
  );
  assert.match(
    migration033Source,
    /UNIQUE \(trigger_message_id, follow_up_step\)/i
  );
  assert.match(
    migration033Source,
    /CHECK \(action IN \('skip', 'human_review'\)\)/i
  );
});
