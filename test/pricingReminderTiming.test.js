const test = require("node:test");
const assert = require("node:assert/strict");
const { canFitBeforeFinal, canSendAfterFinal, statusForPricingSend } = require("../src/services/pricingReminderService");
const { finalDueSql } = require("../src/db/pricingReminderRepo");

const steps = [
  { delayMinutes: 120, timingMode: "after_reply", beforeWindowExpiryMinutes: 120 },
  { delayMinutes: 360, timingMode: "after_reply", beforeWindowExpiryMinutes: 120 },
  { delayMinutes: 1320, timingMode: "before_window_expiry", beforeWindowExpiryMinutes: 120 },
];

test("pricing must leave at least two hours before final testimonial", () => {
  const now = new Date("2026-10-08T11:00:00Z");
  assert.equal(canFitBeforeFinal({
    final_due_at: "2026-10-08T13:00:00Z",
  }, now), true);
  assert.equal(canFitBeforeFinal({
    final_due_at: "2026-10-08T12:59:59Z",
  }, now), false);
  assert.equal(canFitBeforeFinal({
    final_due_at: "2026-10-08T10:00:00Z",
  }, now), false);
  assert.equal(canFitBeforeFinal({
    final_due_at: null,
  }, now), false);
});

test("quiet-hour-aware SQL plans the final testimonial before pricing", () => {
  const expr = finalDueSql({
    steps,
    quietHours: { enabled:true, start:"00:00", end:"07:00" },
  });
  assert.match(expr, /quiet|CASE WHEN 3 = 3/i);
  assert.match(expr, /second\.created_at/);
});

test("after-reply final timing includes spacing from step two", () => {
  const expr = finalDueSql({
    steps:[steps[0],steps[1],{ delayMinutes:900,timingMode:"after_reply",beforeWindowExpiryMinutes:120 }],
    quietHours: { enabled:false, start:"00:00", end:"07:00" },
  });
  assert.match(expr, /second\.created_at \+ interval '540 minutes'/);
});

test("ambiguous provider timeouts remain unconfirmed, not failed", () => {
  assert.equal(statusForPricingSend({
    success: false, unknown: true, ambiguous: true,
  }), "unknown");
  assert.equal(statusForPricingSend({
    success: false, ambiguous: true,
  }), "unknown");
  assert.equal(statusForPricingSend({
    success: false, error: "WhatsApp rejected the image",
  }), "failed");
  assert.equal(statusForPricingSend({success: true}), "sent");
});

test("post-final graphic waits five minutes and requires an open WhatsApp window", () => {
  const now = new Date("2026-10-08T12:05:00Z");
  const candidate = {
    final_due_at: "2026-10-08T12:00:00Z",
    inbound_at: "2026-10-08T00:00:00Z",
  };
  assert.equal(canSendAfterFinal(candidate, now), true);
  assert.equal(canSendAfterFinal(candidate, new Date("2026-10-08T12:04:59Z")), false);
  assert.equal(canSendAfterFinal({
    ...candidate, final_due_at: "2026-10-08T12:03:00Z",
  }, now), false);
  assert.equal(canSendAfterFinal({
    final_due_at: "2026-10-08T23:48:00Z",
    inbound_at: "2026-10-08T00:00:00Z",
  }, new Date("2026-10-08T23:53:00Z")), false);
  assert.equal(canSendAfterFinal({
    final_due_at: null, inbound_at: "2026-10-08T00:00:00Z",
  }, now), false);
});
