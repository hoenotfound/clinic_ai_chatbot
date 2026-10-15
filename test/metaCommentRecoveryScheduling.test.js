const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const commentRepo = require("../src/db/metaCommentAutomationRepo");
const {
  recoveryDelayForResult,
} = require("../src/services/metaCommentAutomationService");

test("comment recovery sleeps through idle periods and wakes at the precise next retry", () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(recoveryDelayForResult({ nextRecoverableAt: null }, now), 15 * 60 * 1000);
  assert.equal(recoveryDelayForResult({
    nextRecoverableAt: "2026-10-15T10:00:15Z",
  }, now), 15000);
  assert.equal(recoveryDelayForResult({
    nextRecoverableAt: "2026-10-15T09:59:00Z",
  }, now), 1000);
  assert.equal(recoveryDelayForResult({
    nextRecoverableAt: "invalid",
  }, now), 60 * 1000);
});

test("next comment recovery covers due retries and stale processing without changing retry limits", async () => {
  let captured;
  const next = new Date("2026-10-15T10:00:15Z");
  const database = {
    async query(sql, values) {
      captured = { sql, values };
      return { rows: [{ due_at: next }] };
    },
  };
  assert.equal(await commentRepo.getNextRecoverableAt(database), next);
  assert.match(captured.sql, /MIN\(/);
  assert.match(captured.sql, /next_attempt_at/);
  assert.match(captured.sql, /status = 'processing'/);
  assert.match(captured.sql, /updated_at \+ \(\$2::integer \* interval '1 minute'\)/);
  assert.deepEqual(captured.values, [
    commentRepo.MAX_ATTEMPTS,
    commentRepo.STALE_PROCESSING_MINUTES,
  ]);
  assert.equal(
    await commentRepo.getNextRecoverableAt({ query: async () => ({ rows: [{ due_at: null }] }) }),
    null
  );
});

test("live comment webhooks stay immediate while recovery no longer polls every minute", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/metaCommentAutomationService.js"),
    "utf8"
  );
  assert.match(source, /const task = scheduledJobChain\.then\(\(\) => processJob\(jobOrId\)\)/);
  assert.match(source, /createRecoveryTimer\(/);
  assert.match(source, /getNextRecoverableAt\(/);
  assert.doesNotMatch(source, /setInterval\(/);
  assert.doesNotMatch(source, /recoveryWorker\?\.wake\(0\);[\s\S]*?if \(job\) accepted\.push/);
});

test("Meta webhook applies staff echoes before starting immediate comment processing", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/createApp.js"), "utf8"
  );
  const echoIndex = source.indexOf("await metaStaffEcho.finalizeStaffEcho(persisted)");
  const commentIndex = source.indexOf("metaCommentAutomation.scheduleJob(job.id)");
  assert.ok(echoIndex >= 0 && commentIndex > echoIndex,
    "comment processing must remain after staff-echo finalization");
});
