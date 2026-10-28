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

test("secondary status-only callbacks cannot enter primary delivery or billing workers",()=>{
  const body={object:"whatsapp_business_account",entry:[
    {id:S_ACC,changes:[{field:"messages",value:{
      metadata:{phone_number_id:SECONDARY},
      statuses:[{id:"wamid.ariel",status:"failed",pricing:{billable:true}}],
    }}]},
  ]};
  const result=partitionSecondaryInboxWebhook(body,opts);
  assert.equal(result.acceptedActionable,0);
  assert.deepEqual(result.acceptedBody.entry,[]);
  assert.equal(result.quarantined.length,1);
  assert.equal(result.quarantined[0].reason,"unsupported_whatsapp_event");
});
test("mixed Ariel message and status preserves customer text without billing receipt",()=>{
  const result=partitionSecondaryInboxWebhook({
    object:"whatsapp_business_account",
    entry:[{id:S_ACC,changes:[{field:"messages",value:{
      metadata:{phone_number_id:SECONDARY},
      messages:[{id:"incoming",from:"60127777777",text:{body:"Hi"}}],
      statuses:[{id:"send",status:"sent"}],
    }}]}],
  },opts);
  assert.equal(result.acceptedActionable,1);
  assert.equal(result.quarantined.length,1);
  assert.equal(result.quarantined[0].reason,"unsupported_whatsapp_event");
  const safe=result.acceptedBody.entry[0].changes[0].value;
  assert.equal(safe.messages[0].id,"incoming");
  assert.equal("statuses" in safe,false);
});
test("primary delivery statuses still flow through the existing verified sender",()=>{
  const result=partitionSecondaryInboxWebhook({
    object:"whatsapp_business_account",
    entry:[{id:P_ACC,changes:[{field:"messages",value:{
      metadata:{phone_number_id:PRIMARY},
      statuses:[{id:"neutro",status:"delivered"}],
    }}]}],
  },opts);
  assert.equal(result.quarantined.length,0);
  assert.equal(result.acceptedActionable,1);
  assert.equal(result.acceptedBody.entry[0].changes[0].value.statuses.length,1);
});
test("unknown account passive sync is quarantined instead of being accepted",()=>{
  const result=partitionSecondaryInboxWebhook({
    object:"whatsapp_business_account",
    entry:[
      {id:"299999999999999",changes:[{field:"history",value:{history:[]}}]},
      {id:S_ACC,changes:[{field:"smb_app_state_sync",value:{state_sync:[]}}]},
    ],
  },opts);
  assert.equal(result.quarantined.length,1);
  assert.equal(result.quarantined[0].reason,"different_business_account");
  assert.equal(result.acceptedBody.entry.length,1);
  assert.equal(result.acceptedBody.entry[0].id,S_ACC);
});
