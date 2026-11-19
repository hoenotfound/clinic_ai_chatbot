"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {alignedMaintenanceDelay,MAINTENANCE_WINDOW_MS}=require("../src/utils/maintenanceWindow");
test("non-urgent maintenance shares clock boundaries with less than five minutes deferral",()=>{
 for(const interval of [3600000,21600000,86400000]){
  for(const offset of [0,1,12345,299999]){
   const now=Date.parse('2026-11-19T00:00:00Z')+offset;
   const delay=alignedMaintenanceDelay(interval,now);
   assert.ok(delay>=interval&&delay<interval+MAINTENANCE_WINDOW_MS);
   assert.equal((now+delay)%MAINTENANCE_WINDOW_MS,0);
  }
 }
 assert.equal(alignedMaintenanceDelay(3600000,1000)+1000,alignedMaintenanceDelay(3600000,2000)+2000);
 assert.throws(()=>alignedMaintenanceDelay(0));
});
