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

const { createMaintenanceSchedule, IDLE_OFFSETS_MS } = require("../src/utils/maintenanceWindow");
const { createIdleAwareRecoveryWorker } = require("../src/utils/idleAwareRecoveryWorker");
const { createAdaptiveWorkerTimer } = require("../src/utils/adaptiveWorkerTimer");
const appointment = require("../src/services/staffAppointmentReminderRecoveryService");
const fep = require("../src/services/whatsappFreeEntryFollowUpService");
const media = require("../src/services/whatsappSecondaryAiMediaQueue");
const delivery = require("../src/services/whatsappDeliveryStatusService");
const lifecycle = require("../src/services/customerDataLifecycleService");
const clinic = require("../src/config/clinicConfig");

function fakeClock(start = now) {
  let current = start;
  const timers = new Map();
  return {
    now: () => current,
    setTimeoutImpl(fn, delay) {
      const handle = { unref() {} };
      timers.set(handle, { fn, at: current + delay });
      return handle;
    },
    clearTimeoutImpl(handle) { timers.delete(handle); },
    next: () => Math.min(...Array.from(timers.values(), x => x.at)),
    async advance(ms) {
      const end = current + ms;
      for (let count = 0; count < 100; count++) {
        const entry = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
        if (!entry || entry[1].at > end) { current = end; return; }
        current = entry[1].at;
        timers.delete(entry[0]);
        await entry[1].fn();
      }
      throw Error("Unexpected timer loop");
    },
  };
}
function enable(t) {
  for (const [key, value] of Object.entries({...enabled, WHATSAPP_FEP_FOLLOWUPS_ENABLED:"true"})) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}
test("all named idle jobs have distinct offsets inside the same 45-second window", () => {
  const offsets = Object.values(IDLE_OFFSETS_MS);
  assert.equal(new Set(offsets).size, offsets.length);
  assert.ok(offsets.every(offset => offset >= 0 && offset <= 45000));
  const start = Date.parse("2026-11-26T18:16:00Z");
  const nextHour = Date.parse("2026-11-26T19:00:00Z");
  for (const [label, offset] of Object.entries(IDLE_OFFSETS_MS)) {
    const delay = alignedIdleRecoveryDelay(hour, start, enabled, label);
    assert.ok(delay <= hour);
    assert.equal(start + delay, nextHour + offset);
    const second = alignedIdleRecoveryDelay(hour, nextHour + offset + 1500, enabled, label);
    assert.equal(second, hour - 1500, "completion time cannot cause schedule drift");
  }
});
test("ads analytics, retention and prune share hourly windows while keeping their individual cadence", () => {
  for (const [label, interval] of [["Meta Ads Insights sync",6*hour],["Customer retention sweep",6*hour],["Customer purge-job prune",24*hour]]) {
    const schedule = createMaintenanceSchedule(interval, now, { env:enabled,label });
    const first = now + schedule(now);
    assert.ok(first-now > interval-hour && first-now <= interval);
    assert.equal(first % hour, IDLE_OFFSETS_MS[label]);
    assert.equal(first + 8000 + schedule(first + 8000), first + interval);
    const disabled = createMaintenanceSchedule(interval, now, {env:{},label});
    assert.ok(disabled(now) >= interval);
  }
});
test("enabled recovery worker preserves immediate enqueues, active retries, query failures and return to idle", async t => {
  enable(t);
  const clock = fakeClock();
  const label = "Business App mutation recovery";
  let runs=0, pending=false, fail=false;
  const worker = createIdleAwareRecoveryWorker({
    ...clock,label,emptyIntervalMs:hour,
    run:async()=>{runs++;},
    hasPendingWork:async()=>{if(fail)throw Error("query unavailable");return pending;},
    logger:{error(){}},
  });
  t.after(()=>worker.stop());
  worker.start();
  await clock.advance(0);
  assert.equal(runs,1);
  assert.equal(clock.next(),Date.parse("2026-11-26T19:00:25Z"));
  pending=true;
  assert.equal(worker.wake(0),true);
  await clock.advance(0);
  assert.equal(runs,2);
  assert.equal(clock.next(),now+60000);
  fail=true;
  await clock.advance(60000);
  assert.equal(clock.next(),now+120000);
  fail=false;pending=false;
  await clock.advance(60000);
  assert.equal(clock.next(),Date.parse("2026-11-26T19:00:25Z"));
});
test("appointment recovery retains startup and immediate repair, with an aligned maximum 30-minute fallback", async t => {
  enable(t);
  const previous = clinic.businessType;
  clinic.businessType = "tcm_clinic";
  t.after(()=>{appointment.stop();clinic.businessType=previous;});
  const clock = fakeClock();
  let runs=0;
  assert.equal(appointment.start({...clock,run:async()=>{runs++;}}),true);
  await clock.advance(0);
  assert.equal(runs,1);
  assert.equal(clock.next(),Date.parse("2026-11-26T18:30:40Z"));
  await clock.advance(60000);
  assert.equal(appointment.wake(),true);
  await clock.advance(0);
  assert.equal(runs,2);
  assert.ok(clock.next()-clock.now()<=half);
});
test("enabled FEP worker skips quiet scans, wakes on config change and reads fresh deadlines at reopening", async t => {
  enable(t);
  const original=clinic.automatedFollowUp;
  const quiet={enabled:true,start:"00:00",end:"07:00"};
  clinic.automatedFollowUp={...original,quietHours:quiet};
  t.after(()=>{fep.stop();clinic.automatedFollowUp=original;});
  const clock=fakeClock();
  const handlers=new Map();
  let sweeps=0,hints=0;
  const events={subscribe(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);}};
  fep.start({events,createTimer:options=>createAdaptiveWorkerTimer({
    ...options,...clock,run:()=>options.run({
      clock:clock.now,
      sweep:async()=>{sweeps++;return {skipped:0,retryable:0};},
      readSettings:()=>({active:true}),
      readHint:async()=>{hints++;return {hasOverdue:false,nextDueAt:new Date(clock.now()+120000)};},
    }),
  })});
  await clock.advance(0);
  assert.equal(sweeps,0);assert.equal(hints,0);
  assert.equal(clock.next(),Date.parse("2026-11-26T23:00:00Z"));
  handlers.get("whatsapp_fep_billing_evidence")({});
  await clock.advance(0);
  assert.equal(sweeps,0);
  clinic.automatedFollowUp={...original,quietHours:{...quiet,enabled:false}};
  handlers.get("config_changed")({keys:["automatedFollowUp"]});
  await clock.advance(0);
  assert.equal(sweeps,1);assert.equal(hints,1);
  assert.equal(clock.next(),now+120000);
  clinic.automatedFollowUp={...original,quietHours:quiet};
  handlers.get("config_changed")({keys:["automatedFollowUp"]});
  await clock.advance(0);
  assert.equal(sweeps,1);
  await clock.advance(Date.parse("2026-11-26T23:00:00Z")-clock.now());
  assert.equal(sweeps,2);assert.equal(hints,2);
  assert.equal(clock.next(),clock.now()+120000);
});
test("claimed media, solicited night media, billing retries and purge deadlines keep their original timing", t => {
  enable(t);
  assert.equal(media.nextMediaRecoveryDelay({has_claimed:true,has_pending:false},now),60000);
  assert.equal(media.nextMediaRecoveryDelay({has_claimed:false,has_pending:true,next_pending_at:new Date(now+120000),has_solicited_pending:true,next_solicited_at:new Date(now+120000)},now),120000);
  assert.throws(()=>media.nextMediaRecoveryDelay({has_claimed:false,has_pending:true},now),/deadline unavailable/);
  assert.equal(delivery.recoveryDelayForResult({workCount:1},{runCount:2}),10000);
  assert.equal(delivery.recoveryDelayForResult({pendingBillingAlerts:true},{runCount:2}),30000);
  assert.equal(lifecycle.mediaCleanupDelay(new Date(now+120000),now,enabled),120000);
  assert.equal(lifecycle.mediaCleanupDelay("invalid",now,enabled),600000);
  assert.equal(lifecycle.mediaCleanupDelay(null,now,enabled),44*60000+45000);
  assert.equal(fep.followUpDelayForResult({retryable:1},{hasOverdue:true},now),300000);
  assert.equal(fep.nextPollDelay(new Date(now+120000),now),120000);
});
