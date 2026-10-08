const test = require("node:test");
const assert = require("node:assert/strict");
const { effectiveSlotDueAt } = require("../src/utils/freeEntrySchedule");
const { eligibleFreeEntryTime } = require("../src/utils/whatsappFreeEntryWindow");
const quiet = { enabled:true, start:"00:00", end:"07:00" };
const zone = { timeZone: "Asia/Kuala_Lumpur" };
test("final free-entry template moves before midnight if morning is after expiry", () => {
  const firstReplyAt="2026-10-01T07:00:00+08:00";
  const due=effectiveSlotDueAt(firstReplyAt,162,[26,50,74,98,122,162],quiet,zone);
  assert.equal(due.toISOString(),"2026-10-07T15:55:00.000Z");
  assert.equal(eligibleFreeEntryTime({
    firstInboundAt:"2026-10-01T06:50:00+08:00",
    firstReplyAt,
    lastInboundAt:"2026-10-01T06:50:00+08:00",
    now:"2026-10-07T15:56:00.000Z",
    slotHours:162,sourceIsCtwa:true,evidenceType:"free_entry_point",
    earlyDueAt:due,
  }),true);
});
test("ordinary slots are not pulled earlier and final slot respects a normal window",()=>{
  const first="2026-10-01T11:00:00+08:00";
  assert.equal(effectiveSlotDueAt(first,50,[26,50,162],quiet,zone).getTime(),
    new Date(first).getTime()+50*3600000);
  assert.equal(effectiveSlotDueAt(first,162,[26,50,162],quiet,zone).getTime(),
    new Date(first).getTime()+162*3600000);
});
