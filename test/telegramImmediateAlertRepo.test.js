const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HUMAN_ALERT_LOCK_NAMESPACE,
  claimReady,
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
  assert.deepEqual(fake.calls[2].params, [12, 30]);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
  assert.equal(fake.calls.at(-1).sql, "RELEASE");
  assert.equal(
    fake.calls.some((call) => /INSERT INTO telegram_immediate_alerts/.test(call.sql)),
    false
  );
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
    "Queued human alert",
  ]);
  assert.match(insert.sql, /'pending'/);
  assert.match(insert.sql, /next_attempt_at/);
  assert.equal(fake.calls.at(-2).sql, "COMMIT");
});

test("non-human alerts enqueue without opening an explicit transaction", async () => {
  const calls = [];
  const database = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [{ id: 55, status: "pending" }] };
    },
  };

  const result = await queueAlert({
    eventKey: "booking-ready:12:44",
    type: "booking_ready",
    contactId: 12,
    messageText: "Booking ready",
  }, database);

  assert.equal(result.id, 55);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO telegram_immediate_alerts/);
  assert.doesNotMatch(calls[0].sql, /BEGIN/);
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
  assert.match(source, /status IN \('pending', 'sending', 'sent', 'failed'\)/);
});
