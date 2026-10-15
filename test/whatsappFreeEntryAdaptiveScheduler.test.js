const test = require("node:test");
const assert = require("node:assert/strict");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");

test("extended follow-up timer checks due work at the existing five-minute safety cadence", () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(worker.nextPollDelay(null, now), 15 * 60 * 1000);
  assert.equal(worker.nextPollDelay("invalid", now), 5 * 60 * 1000);
  assert.equal(worker.nextPollDelay("2026-10-15T09:59:00Z", now), 5 * 60 * 1000);
  assert.equal(worker.nextPollDelay("2026-10-15T10:02:00Z", now), 2 * 60 * 1000);
  assert.equal(worker.nextPollDelay("2026-10-15T12:00:00Z", now), 15 * 60 * 1000);
});

test("extended follow-up scheduler handles conversation, pipeline and config wakes without fixed setInterval", () => {
  const original = process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED;
  process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED = "true";
  let started = 0;
  let stopped = 0;
  const wakeDelays = [];
  const subscriptions = new Map();
  let timerOptions;
  let active = false;
  const events = {
    subscribe(name, fn) {
      subscriptions.set(name, fn);
      return () => subscriptions.delete(name);
    },
  };
  const timerFactory = (options) => {
    timerOptions = options;
    return {
      start() { started++; active = true; },
      stop() { stopped++; active = false; },
      state() { return { stopped: !active }; },
      wake(delay) { wakeDelays.push(delay); return true; },
    };
  };

  try {
    const stop = worker.start({ createTimer: timerFactory, events });
    assert.equal(started, 1);
    assert.equal(subscriptions.size, 3);
    assert.equal(timerOptions.errorRetryDelayMs, 5 * 60 * 1000);
    assert.equal(timerOptions.delayForResult(60000), 60000);
    events.subscribe && subscriptions.get("conversation_changed")({ contactId: 37 });
    subscriptions.get("pipeline_changed")({ leadId: 21 });
    subscriptions.get("config_changed")({ keys: ["theme"] });
    subscriptions.get("config_changed")({ keys: ["automatedFollowUp"] });
    assert.deepEqual(wakeDelays, [300000, 300000, 0]);
    assert.equal(worker.start({ createTimer: timerFactory, events }), worker.stop,
      "starting the worker twice must not schedule a second worker");
    assert.equal(started, 1);
    stop();
    assert.equal(stopped, 1);
    assert.equal(subscriptions.size, 0);
    assert.equal(worker.wake(), false);
  } finally {
    worker.stop();
    if (original === undefined) delete process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED;
    else process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED = original;
  }
});

test("next-due query is only a wake hint and retains Meta billing evidence and unique attempt exclusions", () => {
  const sql = worker.potentialDueSql;
  assert.match(sql, /proof\.pricing_type = 'free_entry_point'/);
  assert.match(sql, /proof\.billable = false/);
  assert.match(sql, /whatsapp_free_entry_referrals entry/);
  assert.match(sql, /last_inbound\.created_at \+ interval '24 hours'/);
  assert.match(sql, /last_outbound\.created_at/);
  assert.match(sql, /slot\.hours - CASE WHEN slot\.hours/);
  assert.match(sql, /slot\.hours \+ 12/);
  assert.match(sql, /NOT EXISTS \(/);
  assert.match(sql, /FREE_ONLY_POLICY_DEFERRED_NO_PROVIDER_SEND/);
  assert.match(sql, /origin\.created_at > reply\.created_at - interval '24 hours'/);
});

test("worker retains all existing consent, duplicate, quiet-hours and provider-send guards", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  for (const required of [
    "lead.marketing_consent = 'opted_in'",
    "c.whatsapp_marketing_opt_out_at IS NULL",
    "prior.status IN ('sending', 'failed', 'unknown')",
    "NOT EXISTS (",
    "terminalFollowUpDecisionSql",
    "quietHoursStatus",
    "preflightTemplate",
    "pg_advisory_xact_lock",
    "sendApprovedTemplate",
    "ON CONFLICT (first_reply_message_id, slot_hours) DO NOTHING",
  ]) {
    assert.ok(source.includes(required), `Missing safeguard: ${required}`);
  }
  assert.doesNotMatch(source, /setInterval\(/);
});
