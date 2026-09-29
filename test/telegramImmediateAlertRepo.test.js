const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HUMAN_ALERT_LOCK_NAMESPACE,
  IMMEDIATE_ALERT_MAX_STALE_RECOVERIES,
  claimReady,
  markCancelled,
  markExhaustedStale,
  markFailed,
  queueAlert,
} = require("../src/db/telegramImmediateAlertRepo");

function fakeDatabase(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return handler(sql, params, calls);
    },
    release() {
      calls.push({ sql: "RELEASE", params: [] });
    },
  };
  return {
    database: {
      connect: async () => client,
      query: client.query.bind(client),
    },
    calls,
  };
}

test("human immediate queue serializes per contact and suppresses the 30-minute cooldown", async () => {
  const fake = fakeDatabase(async (sql) => {
    if (/FROM telegram_immediate_alerts/.test(sql) && /created_at > now\(\)/.test(sql)) {
      return { rows: [{ id: 99 }] };
    }
    return { rows: [] };
  });

  const result = await queueAlert({
    eventKey: "human:12:45",
    type: "human_intervention",
    contactId: 12,
    messageText: "Human attention",
    cooldownMinutes: 30,
  }, fake.database);

  assert.equal(result, null);
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.match(fake.calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(fake.calls[1].params, [HUMAN_ALERT_LOCK_NAMESPACE, 12]);
  assert.match(fake.calls[2].sql, /created_at > now\(\) - \(\$2::integer \* interval '1 minute'\)/);
  assert.deepEqual(fake.calls[2].params, [12, 30, "human_intervention"]);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
  assert.equal(
    fake.calls.some((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql)),
    false
  );
});

test("delivery alerts use the same per-contact type cooldown without suppressing other alert types", async () => {
  const fake = fakeDatabase(async (sql, params) => {
    if (/FROM telegram_immediate_alerts/.test(sql) && /created_at > now\(\)/.test(sql)) {
      assert.deepEqual(params, [12, 15, "delivery_failure"]);
      return { rows: [{ id: 88 }] };
    }
    return { rows: [] };
  });

  const result = await queueAlert({
    eventKey: "delivery:12:event:test",
    type: "delivery_failure",
    contactId: 12,
    messageText: "Delivery failed",
    cooldownMinutes: 15,
  }, fake.database);

  assert.equal(result, null);
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.match(fake.calls[2].sql, /alert_type = \$3/);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
});

test("new human immediate alert is committed as pending queue work", async () => {
  const fake = fakeDatabase(async (sql, params) => {
    if (/FROM telegram_immediate_alerts/.test(sql) && /created_at > now\(\)/.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO telegram_immediate_alerts/.test(sql)) {
      return { rows: [{ id: 100, event_key: params[0], status: "pending" }] };
    }
    return { rows: [] };
  });

  const result = await queueAlert({
    eventKey: "human:12:46",
    type: "human_intervention",
    contactId: 12,
    messageText: "Queued human alert",
    cooldownMinutes: 30,
  }, fake.database);

  assert.equal(result.id, 100);
  assert.equal(result.status, "pending");
  const insert = fake.calls.find((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql));
  assert.deepEqual(insert.params, [
    "human:12:46",
    "human_intervention",
    12,
    null,
    "Queued human alert",
  ]);
  assert.match(insert.sql, /'pending'/);
  assert.match(insert.sql, /next_attempt_at/);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
});

test("staff-waiting alerts enqueue without opening an explicit transaction", async () => {
  const calls = [];
  const database = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [{ id: 55, status: "pending" }] };
    },
  };

  const result = await queueAlert({
    eventKey: "staff_waiting:12:44",
    type: "staff_waiting",
    contactId: 12,
    leadId: 7,
    messageText: "Customer waiting",
  }, database);

  assert.equal(result.id, 55);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO telegram_immediate_alerts/);
  assert.deepEqual(calls[0].params, [
    "staff_waiting:12:44",
    "staff_waiting",
    12,
    7,
    "Customer waiting",
  ]);
});

test("Booking Ready serializes per contact and cancels older pending versions for the same lead", async () => {
  const fake = fakeDatabase(async (sql, params) => {
    if (/SET status = 'cancelled'/.test(sql) && /alert_type = 'booking_ready'/.test(sql)) {
      assert.deepEqual(params, [12, 7, "booking-ready:12:45"]);
      return { rows: [{ id: 41, status: "cancelled" }] };
    }
    if (/INSERT INTO telegram_immediate_alerts/.test(sql)) {
      return { rows: [{ id: 42, status: "pending", lead_id: 7 }] };
    }
    return { rows: [] };
  });

  const result = await queueAlert({
    eventKey: "booking-ready:12:45",
    type: "booking_ready",
    contactId: 12,
    leadId: 7,
    messageText: "Latest booking details",
  }, fake.database);

  assert.equal(result.id, 42);
  assert.equal(fake.calls[0].sql, "BEGIN");
  assert.match(fake.calls[1].sql, /pg_advisory_xact_lock/);
  assert.match(fake.calls[2].sql, /Superseded by newer Booking Ready details/);
  assert.match(fake.calls[3].sql, /INSERT INTO telegram_immediate_alerts/);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
});

test("ready queue claims use SKIP LOCKED and lease fencing", async () => {
  let captured = null;
  const rows = [{ id: 8, lease_token: "returned-lease", attempts: 1 }];
  const result = await claimReady(
    { limit: 5, staleAfterSeconds: 60, maxAttempts: 5 },
    async (sql, params) => {
      captured = { sql, params };
      return { rows };
    }
  );

  assert.deepEqual(result, rows);
  assert.match(captured.sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(captured.sql, /status = 'sending'/);
  assert.match(captured.sql, /attempts = alert\.attempts \+ 1/);
  assert.equal(captured.params[0], 5);
  assert.equal(captured.params[1], 60);
  assert.equal(captured.params[2], 5);
  assert.match(captured.params[3], /^[0-9a-f]{32}$/);
});

test("failed queue work is fenced by lease and schedules retry or terminal state", async () => {
  let captured = null;
  await markFailed(
    8,
    "lease-8",
    new Error("Telegram unavailable"),
    { retryDelaySeconds: 120, maxAttempts: 5 },
    async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ id: 8, status: "pending" }] };
    }
  );

  assert.match(captured.sql, /attempts >= \$4 THEN 'failed' ELSE 'pending'/);
  assert.match(captured.sql, /lease_token = \$2/);
  assert.match(captured.sql, /next_attempt_at/);
  assert.deepEqual(captured.params, [
    8,
    "lease-8",
    120,
    5,
    "Telegram unavailable",
  ]);
});

test("resolved reminders are cancelled terminally under the active lease", async () => {
  let captured = null;
  const row = await markCancelled(
    9,
    "lease-9",
    "Staff already replied.",
    async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ id: 9, status: "cancelled" }] };
    }
  );

  assert.deepEqual(row, { id: 9, status: "cancelled" });
  assert.match(captured.sql, /status = 'cancelled'/);
  assert.match(captured.sql, /terminal_at = COALESCE\(terminal_at, now\(\)\)/);
  assert.match(captured.sql, /lease_token = \$2/);
  assert.deepEqual(captured.params, [9, "lease-9", "Staff already replied."]);
});

test("migration upgrades old sent markers without replaying them", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "../src/db/migrations/020_telegram_immediate_alert_queue.sql"),
    "utf8"
  );

  assert.match(source, /UPDATE telegram_immediate_alerts[\s\S]*status = 'sent'/);
  assert.match(source, /sent_at = COALESCE\(sent_at, created_at\)/);
  assert.match(source, /ALTER COLUMN status SET DEFAULT 'sent'/);
  assert.match(source, /new queue writer explicitly[\s\S]*status='pending'/);
  assert.match(source, /status IN \('pending', 'sending', 'sent', 'failed', 'cancelled'\)/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS lead_id INTEGER/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS stale_recoveries INTEGER NOT NULL DEFAULT 0/);
});

test("ambiguous final stale attempts get one bounded recovery chance", async () => {
  let captured = null;
  const first = await markExhaustedStale(
    { staleAfterSeconds: 60, maxAttempts: 5, maxStaleRecoveries: 1 },
    async (sql, params) => {
      captured = { sql, params };
      return {
        rows: [{
          id: 9,
          status: "pending",
          attempts: 4,
          stale_recoveries: 1,
          terminal_at: null,
        }],
      };
    }
  );

  assert.equal(IMMEDIATE_ALERT_MAX_STALE_RECOVERIES, 1);
  assert.deepEqual(captured.params, [60, 5, 1]);
  assert.match(captured.sql, /stale_recoveries < \$3 THEN 'pending'/);
  assert.match(captured.sql, /THEN GREATEST\(0, \$2 - 1\)/);
  assert.equal(first[0].status, "pending");
  assert.equal(first[0].attempts, 4);
  assert.equal(first[0].stale_recoveries, 1);
});
