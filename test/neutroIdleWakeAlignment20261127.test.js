"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { alignedIdleRecoveryDelay } = require("../src/utils/maintenanceWindow");
const { freeEntryQuietDelay } = require("../src/services/whatsappFreeEntryFollowUpService");
const enabled = { NEUTRO_IDLE_MAINTENANCE_ALIGN_ENABLED: "true", CLINIC_TIMEZONE: "Asia/Kuala_Lumpur" };
const hour = 60 * 60 * 1000;
const half = hour / 2;
const now = Date.parse("2026-11-26T18:16:00Z");
test("empty recovery uses a shared boundary without extending the existing maximum wait", () => {
  for (const interval of [half, hour]) {
    for (const offset of [0, 1234, 16*60000, 29*60000, 59*60000]) {
      const clock = Date.parse("2026-11-26T18:00:00Z") + offset;
      const delay = alignedIdleRecoveryDelay(interval, clock, enabled);
      assert.ok(delay > 0 && delay <= interval);
      assert.equal((clock + delay) % interval, 0);
    }
  }
  assert.equal(alignedIdleRecoveryDelay(hour, now, enabled), 44*60000);
  assert.equal(alignedIdleRecoveryDelay(half, now, enabled), 14*60000);
});
test("near a common boundary never runs a zero-delay loop; opt-out and unsupported intervals unchanged", () => {
  assert.equal(alignedIdleRecoveryDelay(hour, Date.parse("2026-11-26T18:59:59.500Z"), enabled), 1000);
  assert.equal(alignedIdleRecoveryDelay(hour, now, {}), hour);
  assert.equal(alignedIdleRecoveryDelay(60000, now, enabled), 60000);
  assert.equal(alignedIdleRecoveryDelay(hour, NaN, enabled), hour);
});
test("extended free-entry scans sleep only when configured quiet hours actually prohibit sends", () => {
  const quiet = { enabled:true, start:"00:00", end:"07:00" };
  assert.equal(freeEntryQuietDelay(now, quiet, enabled), 4*hour + 44*60000);
  assert.equal(freeEntryQuietDelay(Date.parse("2026-11-26T23:00:00Z"), quiet, enabled), null);
  assert.equal(freeEntryQuietDelay(now, {...quiet,enabled:false}, enabled), null);
  assert.equal(freeEntryQuietDelay(now, {enabled:true,start:"20:00",end:"01:00"}, enabled), null);
  assert.equal(freeEntryQuietDelay(now, {enabled:true,start:"23:00",end:"05:00"}, enabled), 2*hour + 44*60000);
  assert.equal(freeEntryQuietDelay(now, {enabled:true,start:"bad",end:"07:00"}, enabled), null);
  assert.equal(freeEntryQuietDelay(now, quiet, {}), null);
});
