"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {partitionSecondaryInboxWebhook}=require("../src/services/whatsappSecondaryInboxBoundary");
const PRIMARY="100000000000001", SECONDARY="100000000000002";
const P_ACC="200000000000001",S_ACC="200000000000002";
const opts={primaryPhoneId:PRIMARY,primaryAccountId:P_ACC,
 secondaryPhoneId:SECONDARY,secondaryAccountId:S_ACC};
function event(id,phone,field="messages") {return {field,value:{
 metadata:{phone_number_id:phone},
 ...(field==="messages"?{messages:[{id,from:"60127777777",type:"text",text:{body:"Hi"}}]}:
 {message_echoes:[{id,to:"60127777777",type:"text",text:{body:"Hi"}}]})
}};}
test("primary and secondary customer messages retain separate Meta identities",()=>{
 const data={object:"whatsapp_business_account",entry:[
   {id:P_ACC,changes:[event("p",PRIMARY)]},
   {id:S_ACC,changes:[event("s",SECONDARY)]},
 ]};
 const result=partitionSecondaryInboxWebhook(data,opts);
 assert.equal(result.acceptedActionable,2);
 assert.equal(result.quarantined.length,0);
 assert.deepEqual(result.acceptedBody.entry.map(e=>e.id),[P_ACC,S_ACC]);
});
test("secondary Business App echoes can sync but foreign Meta events are quarantined",()=>{
 const x={object:"whatsapp_business_account",entry:[
  {id:S_ACC,changes:[event("echo",SECONDARY,"smb_message_echoes")]},
  {id:"299999999999999",changes:[event("bad","109999999999999")]},
 ]};
 const data=partitionSecondaryInboxWebhook(x,opts);
 assert.equal(data.acceptedActionable,1);
 assert.equal(data.quarantined.length,1);
 assert.equal(data.acceptedBody.entry[0].changes[0].field,"smb_message_echoes");
});
test("malformed secondary metadata and sender mismatch cannot turn into primary work",()=>{
 const mixed={object:"whatsapp_business_account",entry:[{id:S_ACC,changes:[
   event("wrong",PRIMARY),event("missing",undefined),
   event("correct",SECONDARY),
 ]}]};
 const res=partitionSecondaryInboxWebhook(mixed,opts);
 assert.equal(res.acceptedActionable,1);
 assert.equal(res.quarantined.length,2);
 assert.equal(res.acceptedBody.entry[0].changes[0].value.messages[0].id,"correct");
});
test("inbox-only routing rejects missing or same Meta business phone IDs",()=>{
 assert.throws(()=>partitionSecondaryInboxWebhook({object:"whatsapp_business_account",entry:[]},
   {...opts,secondaryPhoneId:PRIMARY}),/distinct/);
});
