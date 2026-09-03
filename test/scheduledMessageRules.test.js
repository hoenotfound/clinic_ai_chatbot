const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CUSTOMER_SERVICE_WINDOW_MS,
  getServiceWindowEndsAt,
  validateScheduledTime,
} = require("../src/services/scheduledMessageRules");

test("service window ends 24 hours after the latest inbound message", () => {
  const inbound = new Date("2026-09-03T00:00:00.000Z");
  const expected = new Date(inbound.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  assert.equal(getServiceWindowEndsAt(inbound).toISOString(), expected.toISOString());
});

test("accepts a future time inside the 24-hour reply window", () => {
  const result = validateScheduledTime({
    now: "2026-09-03T01:00:00.000Z",
    lastInboundAt: "2026-09-03T00:00:00.000Z",
    scheduledFor: "2026-09-03T12:00:00.000Z",
  });
  assert.equal(result.valid, true);
  assert.equal(result.code, null);
});

test("rejects a scheduled time at or beyond the reply-window boundary", () => {
  const result = validateScheduledTime({
    now: "2026-09-03T01:00:00.000Z",
    lastInboundAt: "2026-09-03T00:00:00.000Z",
    scheduledFor: "2026-09-04T00:00:00.000Z",
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, "outside_window");
});

test("rejects past times and conversations without an inbound message", () => {
  const past = validateScheduledTime({
    now: "2026-09-03T02:00:00.000Z",
    lastInboundAt: "2026-09-03T00:00:00.000Z",
    scheduledFor: "2026-09-03T01:00:00.000Z",
  });
  assert.equal(past.valid, false);
  assert.equal(past.code, "not_future");

  const missingInbound = validateScheduledTime({
    now: "2026-09-03T02:00:00.000Z",
    lastInboundAt: null,
    scheduledFor: "2026-09-03T03:00:00.000Z",
  });
  assert.equal(missingInbound.valid, false);
  assert.equal(missingInbound.code, "no_customer_message");
});
