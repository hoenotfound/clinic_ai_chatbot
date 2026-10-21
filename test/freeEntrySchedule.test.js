const test = require("node:test");
const assert = require("node:assert/strict");
const { effectiveSlotDueAt } = require("../src/utils/freeEntrySchedule");
const { eligibleFreeEntryTime } = require("../src/utils/whatsappFreeEntryWindow");
const quiet = { enabled:true, start:"00:00", end:"07:00" };
const zone = { timeZone: "Asia/Kuala_Lumpur" };
test("final free-entry template moves before midnight if morning is after expiry", () => {
  const firstReplyAt="2026-10-01T07:00:00+08:00";
  const due=effectiveSlotDueAt(firstReplyAt,162,[26,50,74,98,122,162],quiet,
    {...zone,maxCeilingHours:168});
  assert.equal(due.toISOString(),"2026-10-07T15:55:00.000Z");
  assert.equal(eligibleFreeEntryTime({
    firstInboundAt:"2026-10-01T06:50:00+08:00",
    firstReplyAt,
    lastInboundAt:"2026-10-01T06:50:00+08:00",
    now:"2026-10-07T15:56:00.000Z",
    slotHours:162,sourceIsCtwa:true,evidenceType:"free_entry_point",
    earlyDueAt:due,maxCeilingHours:168,
  }),true);
});
test("ordinary slots are not pulled earlier and final slot respects a normal window",()=>{
  const first="2026-10-01T11:00:00+08:00";
  assert.equal(effectiveSlotDueAt(first,50,[26,50,162],quiet,zone).getTime(),
    new Date(first).getTime()+50*3600000);
  assert.equal(effectiveSlotDueAt(first,162,[26,50,162],quiet,zone).getTime(),
    new Date(first).getTime()+162*3600000);
});


test("71h normal due cannot pass a 72h ceiling with the one-hour safety buffer", () => {
  const firstReplyAt = "2026-10-01T11:00:00+08:00";
  const firstInboundAt = "2026-10-01T10:50:00+08:00";
  const disabledQuiet = { enabled: false, start: "00:00", end: "07:00" };
  const due = effectiveSlotDueAt(firstReplyAt, 71, [26, 71], disabledQuiet,
    { ...zone, maxCeilingHours: 72 });
  assert.equal(due.getTime(), new Date(firstReplyAt).getTime() + 71 * 3600000);
  assert.equal(eligibleFreeEntryTime({
    firstInboundAt, firstReplyAt, lastInboundAt: firstInboundAt,
    now: due, slotHours: 71, sourceIsCtwa: true,
    evidenceType: "free_entry_point", earlyDueAt: due, maxCeilingHours: 72,
  }), false);
  // Enabling quiet hours is only conditional: the due time also must fall
  // inside a quiet period that would otherwise cross the safety deadline.
  const noShift = effectiveSlotDueAt(firstReplyAt, 71, [26, 71], quiet,
    { ...zone, maxCeilingHours: 72 });
  assert.equal(noShift.getTime(), due.getTime());
});

test("71h final slot can move before the 72h safety buffer when quiet hours overlap", () => {
  const firstReplyAt = "2026-10-01T03:00:00+08:00";
  const firstInboundAt = "2026-10-01T02:50:00+08:00";
  const due = effectiveSlotDueAt(firstReplyAt, 71, [26, 71], quiet,
    { ...zone, maxCeilingHours: 72 });
  assert.equal(due.toISOString(), "2026-10-03T15:55:00.000Z");
  assert.equal(eligibleFreeEntryTime({
    firstInboundAt, firstReplyAt, lastInboundAt: firstInboundAt,
    now: "2026-10-03T15:56:00.000Z",
    slotHours: 71, sourceIsCtwa: true, evidenceType: "free_entry_point",
    earlyDueAt: due, maxCeilingHours: 72,
  }), true);
  // Under a verified 168h ceiling, 71h needs no special early shift.
  const nominalDue = new Date(new Date(firstReplyAt).getTime() + 71 * 3600000);
  assert.equal(eligibleFreeEntryTime({
    firstInboundAt, firstReplyAt, lastInboundAt: firstInboundAt,
    now: nominalDue, slotHours: 71, sourceIsCtwa: true,
    evidenceType: "free_entry_point", maxCeilingHours: 168,
  }), true);
});
