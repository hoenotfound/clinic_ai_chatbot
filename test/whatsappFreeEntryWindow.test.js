const test = require("node:test");
const assert = require("node:assert/strict");
const {
  freeEntryCeilingHours,
  eligibleFreeEntryTime,
  configuredSlots,
  freeEntryEnabled,
} = require("../src/utils/whatsappFreeEntryWindow");

test("Meta free entry ceiling is 7 days after September 28, 2026", () => {
  assert.equal(freeEntryCeilingHours("2026-10-08T00:00:00Z"), 168);
  assert.equal(freeEntryCeilingHours("2026-09-20T00:00:00Z"), 72);
});
test("do not confuse Meta pricing evidence with an ordinary ad referral", () => {
  const sample = {
    firstInboundAt: "2026-10-01T00:00:00Z",
    firstReplyAt: "2026-10-01T00:01:00Z",
    lastInboundAt: "2026-10-01T00:00:00Z",
    now: "2026-10-03T12:00:00Z",
    slotHours: 36,
    sourceIsCtwa: true,
    evidenceType: "free_entry_point",
  };
  assert.equal(eligibleFreeEntryTime(sample), true);
  assert.equal(eligibleFreeEntryTime({ ...sample, evidenceType: "regular" }), false);
  assert.equal(eligibleFreeEntryTime({ ...sample, sourceIsCtwa: false }), false);
  assert.equal(eligibleFreeEntryTime({ ...sample, lastInboundAt: "2026-10-02T12:00:00Z" }), false);
  assert.equal(eligibleFreeEntryTime({ ...sample, firstReplyAt: "2026-10-02T01:00:00Z" }), false);
  assert.equal(eligibleFreeEntryTime({ ...sample, now: "2026-10-08T00:00:00Z" }), false);
});
test("extended follow-ups are disabled by default and slots validate", () => {
  assert.equal(freeEntryEnabled({}), false);
  assert.equal(freeEntryEnabled({ WHATSAPP_FEP_FOLLOWUPS_ENABLED: "true" }), true);
  assert.deepEqual(configuredSlots({}), [26,50,74,98,122,146]);
  assert.deepEqual(configuredSlots({ WHATSAPP_FEP_SLOT_HOURS: "168" }), []);
  assert.deepEqual(configuredSlots({ WHATSAPP_FEP_SLOT_HOURS: "36,36" }), []);
});
