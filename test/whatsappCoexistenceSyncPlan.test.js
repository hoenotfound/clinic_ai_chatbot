"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { prepareCoexistenceSyncPlan } = require("../src/services/whatsappCoexistenceSyncPlan");
const input = {
 phoneNumberId:"290000000000002",
 onboardingCompletedAt:"2026-10-27T02:00:00Z",
 now:new Date("2026-10-27T02:20:00Z"),
 authorized:true,receiverReady:true,importerReady:true,historyConsent:true,
};
test("sync plan includes both one-time requests only after all readiness proof",()=>{
 const plan=prepareCoexistenceSyncPlan(input);
 assert.equal(plan.eligibleToRequest,true);
 assert.deepEqual(plan.requests.map(x=>x.body.sync_type),["smb_app_state_sync","history"]);
 assert.ok(plan.requests.every(x=>x.path==="/290000000000002/smb_app_data"));
});
test("cannot trigger a one-time sync before onboarding, consent or importer readiness",()=>{
 for(const override of [
  {authorized:false},{receiverReady:false},{importerReady:false},
  {now:new Date("2026-10-28T03:00:00Z")},
 ]) {
  const result=prepareCoexistenceSyncPlan({...input,...override});
  assert.equal(result.eligibleToRequest,false);
  assert.deepEqual(result.requests,[]);
 }
});
test("consent refusal must not trigger history transfer",()=>{
 const result=prepareCoexistenceSyncPlan({...input,historyConsent:false});
 assert.deepEqual(result.requests.map(x=>x.body.sync_type),["smb_app_state_sync"]);
});
test("reject invalid or reused phone IDs and missing completed time",()=>{
 assert.throws(()=>prepareCoexistenceSyncPlan({...input,phoneNumberId:"6017-483-1336"}));
 assert.throws(()=>prepareCoexistenceSyncPlan({...input,onboardingCompletedAt:undefined}));
});
