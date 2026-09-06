const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STAFF_WAITING_MINUTES,
  delayUntilNextStaffWaitingAlert,
  findNextStaffWaitingDueAt,
} = require("../src/services/staffWaitingAlertService");

test("staff waiting scheduler calculates the next threshold without polling", async () => {
  let captured = null;
  const dueAt = new Date("2026-09-06T13:10:00.000Z");

  const result = await findNextStaffWaitingDueAt({}, async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ due_at: dueAt }] };
  });

  assert.equal(result, dueAt);
  assert.deepEqual(captured.params, [STAFF_WAITING_MINUTES]);
  assert.match(captured.sql, /MIN\(/);
  assert.match(captured.sql, /latest_waiting\.created_at/);
  assert.match(captured.sql, /telegram_immediate_alerts/);
});

test("staff waiting scheduler sleeps when there is no next deadline", () => {
  assert.equal(delayUntilNextStaffWaitingAlert({ nextDueAt: null }), null);
});
