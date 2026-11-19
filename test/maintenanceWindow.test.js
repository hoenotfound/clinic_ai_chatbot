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

const {createMaintenanceSchedule}=require('../src/utils/maintenanceWindow');
test('hourly, six-hour and daily schedules stay grouped despite nonzero runtimes',()=>{
 const start=Date.parse('2026-11-19T00:02:00Z'),hour=3600000;
 const hourly=createMaintenanceSchedule(hour,start);
 const sixHourly=createMaintenanceSchedule(6*hour,start);
 const daily=createMaintenanceSchedule(24*hour,start);
 let clock=start;
 for(let n=1;n<=24;n++){
  const due=clock+hourly(clock);
  assert.equal(due,Date.parse('2026-11-19T00:05:00Z')+n*hour);
  if(n%6===0){
   assert.equal(clock+sixHourly(clock),due);
   sixHourly(due+32000);
  }
  if(n===24)assert.equal(clock+daily(clock),due);
  clock=due+1000;
 }
});
test('long maintenance runs skip missed slots and keep their original phase',()=>{
 const start=Date.parse('2026-11-19T00:02:00Z');
 const next=createMaintenanceSchedule(3600000,start);
 const completed=Date.parse('2026-11-19T03:16:00Z');
 assert.equal(completed+next(completed),Date.parse('2026-11-19T04:05:00Z'));
 assert.throws(()=>next(NaN));
});
