"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSameRevisionSingleFlight } = require("../src/utils/inboxQuerySingleFlight");

test("simultaneous same-WAL full Inbox queries use one Neon read",async()=>{
  const share=createSameRevisionSingleFlight();
  let calls=0,done;
  const load=()=>{calls++;return new Promise(resolve=>{done=resolve;});};
  const first=share("0/ABCDEF",load);
  const second=share("0/ABCDEF",load);
  assert.strictEqual(first,second);
  await Promise.resolve();
  assert.equal(calls,1);
  done([{contact_id:1}]);
  assert.deepEqual(await first,[{contact_id:1}]);
  assert.deepEqual(await second,[{contact_id:1}]);
  // Results are deliberately NEVER cached across completed requests.
  await share("0/ABCDEF",async()=>{calls++;return [];});
  assert.equal(calls,2);
});
test("different WAL revisions cannot share stale Inbox data",async()=>{
  const share=createSameRevisionSingleFlight();
  let calls=0;
  const first=share("0/AAA1",async()=>{calls++;return ["old"];});
  const second=share("0/AAA2",async()=>{calls++;return ["new"];});
  assert.deepEqual(await Promise.all([first,second]),[["old"],["new"]]);
  assert.equal(calls,2);
});
test("unknown WAL disables sharing and a failed read does not remain cached",async()=>{
  const share=createSameRevisionSingleFlight();
  let calls=0;
  const a=share(null,async()=>++calls);
  const b=share(null,async()=>++calls);
  assert.deepEqual(await Promise.all([a,b]),[1,2]);
  await assert.rejects(share("0/ABCD",async()=>{calls++;throw Error("database offline");}),/database offline/);
  assert.equal(await share("0/ABCD",async()=>{calls++;return "recovered";}),"recovered");
  assert.equal(calls,4);
});
