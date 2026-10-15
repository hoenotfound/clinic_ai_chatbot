const test = require("node:test");
const assert = require("node:assert/strict");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");

test("extended follow-up timer checks due work at the existing five-minute safety cadence", () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(worker.nextPollDelay(null, now), 15 * 60 * 1000);
  assert.equal(worker.nextPollDelay("invalid", now), 5 * 60 * 1000);
  assert.equal(worker.nextPollDelay("2026-10-15T09:59:00Z", now), 15 * 60 * 1000);
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
    assert.equal(subscriptions.size, 4);
    assert.equal(timerOptions.errorRetryDelayMs, 5 * 60 * 1000);
    assert.equal(timerOptions.delayForResult(60000), 60000);
    events.subscribe && subscriptions.get("conversation_changed")({ contactId: 37 });
    subscriptions.get("pipeline_changed")({ leadId: 21 });
    subscriptions.get("config_changed")({ keys: ["theme"] });
    subscriptions.get("config_changed")({ keys: ["automatedFollowUp"] });
    subscriptions.get("whatsapp_fep_billing_evidence")({});
    assert.deepEqual(wakeDelays, [300000, 300000, 0, 0]);
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

test("next-due query shares the CTWA epoch and filters abandoned or unconsented leads", () => {
  const sql = worker.potentialDueSql;
  assert.match(sql, /WITH RECURSIVE qualified AS/);
  assert.match(sql, /reply\.created_at >= origin\.created_at/);
  assert.match(sql, /proof\.pricing_type = 'free_entry_point'/);
  assert.match(sql, /proof\.billable = false/);
  assert.match(sql, /c\.whatsapp_opt_in_at IS NOT NULL/);
  assert.match(sql, /c\.needs_attention = false/);
  assert.match(sql, /lead\.marketing_consent = 'opted_in'/);
  assert.match(sql, /lead\.is_closed = false/);
  assert.match(sql, /prior\.status IN \('sending','failed','unknown'\)/);
  assert.match(sql, /whatsapp_free_only_reconciliations/);
  assert.match(sql, /follow_up_ai_decisions/);
  assert.match(sql, /last_inbound\.created_at AS last_inbound_at/);
  assert.match(sql, /slot\.hours AS slot_hours/);
  assert.match(sql, /slot\.hours \+ 12/);
  assert.match(sql, /FREE_ONLY_POLICY_DEFERRED_NO_PROVIDER_SEND/);
});

test("regular final slot wakes at configured hour, not twelve hours early", () => {
  const old = require("../src/config/clinicConfig").automatedFollowUp;
  const clinicConfig = require("../src/config/clinicConfig");
  const first = "2026-10-15T00:00:00Z";
  const now = new Date("2026-10-17T06:00:00Z");
  try {
    clinicConfig.automatedFollowUp = {
      ...old, quietHours: { enabled: false, start: "00:00", end: "07:00" },
    };
    const result = worker.summarizePotentialDue([{
      first_reply_at: first,
      last_inbound_at: "2026-10-14T23:59:00Z",
      last_outbound_at: first,
      slot_hours: 66,
    }], { slots: [48, 66], sevenDayVerified: false }, now);
    assert.equal(result.hasOverdue, false);
    assert.equal(result.nextDueAt.toISOString(), "2026-10-17T18:00:00.000Z");
    assert.equal(worker.nextPollDelay(result, now.getTime()), 15 * 60 * 1000);
  } finally {
    clinicConfig.automatedFollowUp = old;
  }
});

test("final slot still advances for real expiry-crossing quiet hours", () => {
  const clinicConfig = require("../src/config/clinicConfig");
  const old = clinicConfig.automatedFollowUp;
  const first = "2026-10-15T23:00:00Z"; // 07:00 clinic-local time
  try {
    clinicConfig.automatedFollowUp = {
      ...old, quietHours: { enabled: true, start: "00:00", end: "07:00" },
    };
    const early = worker.summarizePotentialDue([{
      first_reply_at: first,
      last_inbound_at: first,
      last_outbound_at: first,
      slot_hours: 66,
    }], { slots: [48, 66], sevenDayVerified: false }, "2026-10-18T15:00:00Z");
    const scheduled = Date.parse(first) + 66 * 3600000;
    assert.ok(early.nextDueAt.getTime() < scheduled, "quiet-hour expiry must advance due time");
    assert.ok(early.nextDueAt.getTime() >= scheduled - 12 * 3600000);
  } finally {
    clinicConfig.automatedFollowUp = old;
  }
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
  assert.match(source, /result\\?\\.skipped === true/,
    "numeric skipped-contact counts must not cause perpetual fast polling");
});
