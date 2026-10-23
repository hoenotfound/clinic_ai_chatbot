"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const history=require("../src/services/whatsappCoexistenceHistoryService");
const policy=require("../src/services/whatsappSecondaryPolicyService");
const followup=require("../src/services/whatsappSecondaryFollowUpService");
const env={
 WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"110552088553929",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
};
function make(){
 const calls=[],records=new Set();let count=100;
 const connection={query:async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql.includes("INSERT INTO messages"))return{rowCount:1,rows:[{id:++count}]};
   if(sql.includes("INSERT INTO whatsapp_sender_message_context"))return{rowCount:1,rows:[{message_id:count}]};
   return{rowCount:1,rows:[]};
  },release:()=>calls.push({release:true})};
 const database={
  connect:async()=>connection,
  query:async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql.includes("SELECT outcome,messages_count"))return{rows:[]};
   if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))return{rows:[{id:5}]};
   return{rowCount:1,rows:[]};
  },
 };
 const conversations={claimSenderContact:async(params)=>{
   calls.push({claim:params});
   return{id:12,whatsapp_sender_conversation_id:16};
 }};
 return{database,conversations,calls,records};
}
const value={
 metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
 history:[{metadata:{phase:"0",chunk_order:1},threads:[{
   id:"60126662222",messages:[{
     id:"wamid.old-history-1",from:"60126662222",timestamp:String(Math.floor(Date.now()/1000)-7200),
     type:"text",text:{body:"Old customer greeting"},
   },{
     id:"wamid.old-history-2",from:"60123008888",to:"60126662222",
     timestamp:String(Math.floor(Date.now()/1000)-7150),type:"text",
     text:{body:"Old staff message"},
   }]
 }]}],
};
test("history is opt-in and never processes absent or foreign sender credentials",async()=>{
 const f=make();
 assert.equal(history.enabled({}),false);
 assert.deepEqual(await history.acceptPassiveSync({entry:[]},{...f,env:{}}),
  {enabled:false,staged:0});
 assert.deepEqual(await history.importPassiveChange({
   accountId:"wrong",change:{field:"history",value},
 },{...f,env}),{enabled:false,imported:0});
 assert.equal(f.calls.length,0);
});
test("authorised history creates two passive, sender-qualified rows without AI or billing",async()=>{
 const f=make();
 const result=await history.importPassiveChange({accountId:env.WHATSAPP_SECONDARY_WABA_ID,
   change:{field:"history",value}},{...f,env});
 assert.equal(result.imported,2);
 assert.equal(result.threads,1);
 assert.equal(f.calls.filter(x=>x.claim).length,1);
 assert.equal(f.calls.filter(x=>x.sql?.includes("INSERT INTO messages")).length,2);
 assert.equal(f.calls.filter(x=>x.sql?.includes("whatsapp_sender_coexistence_history_messages")).length,2);
 assert.equal(f.calls.filter(x=>x.sql?.includes("INSERT INTO whatsapp_sender_message_context")).length,2);
 assert.ok(f.calls.every(x=>!x.sql?.includes("INSERT INTO whatsapp_sender_billing")));
 assert.ok(f.calls.every(x=>!x.sql?.includes("INSERT INTO follow_up")));
});
test("passive history cannot open an Ariel service window or followup anchor",()=>{
 assert.match(policy.SECONDARY_POLICY_SNAPSHOT_SQL,/whatsapp_sender_coexistence_history_messages/);
 assert.match(followup.CANDIDATES_SQL,/whatsapp_sender_coexistence_history_messages/);
 assert.match(followup.RECHECK_SQL,/whatsapp_sender_coexistence_history_messages/);
});
test("contact-only sync cannot create a send, marketing consent, or AI job",async()=>{
 const f=make();
 const change={field:"smb_app_state_sync",value:{
   metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
   state_sync:[{type:"contact",action:"add",
     contact:{phone_number:"+60 12-666 2222",full_name:"Clinic Visitor"}}],
 }};
 const result=await history.importPassiveChange({
   accountId:env.WHATSAPP_SECONDARY_WABA_ID,change,
 },{...f,env});
 assert.equal(result.contacts,1);
 assert.equal(f.calls.filter(x=>x.claim).length,1);
 assert.ok(f.calls.some(x=>x.sql?.includes("UPDATE contacts SET whatsapp_profile_name")));
 assert.equal(f.calls.some(x=>x.sql?.includes("INSERT INTO messages")),false);
 assert.equal(f.calls.some(x=>x.sql?.includes("INSERT INTO leads")),false);
});
test("declined Meta history sharing is respected",async()=>{
 const f=make();
 const change={field:"history",value:{
  metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
  history:[{errors:[{code:2593109}]}],
 }};
 const r=await history.importPassiveChange({accountId:env.WHATSAPP_SECONDARY_WABA_ID,change},
   {...f,env});
 assert.equal(r.declined,true);
 assert.equal(r.imported,0);
 assert.equal(f.calls.some(x=>x.claim),false);
});

test("webhook acknowledgment stages history as one durable event without importing in request",async()=>{
 const f=make();
 const payload={object:"whatsapp_business_account",entry:[{
  id:env.WHATSAPP_SECONDARY_WABA_ID,changes:[{field:"history",value}],
 }]};
 const result=await history.acceptPassiveSync(payload,{database:f.database,env});
 assert.equal(result.staged,1);
 assert.equal(f.calls.filter(x=>x.sql?.includes("INSERT INTO whatsapp_sender_coexistence_import_jobs")).length,1);
 assert.equal(f.calls.filter(x=>x.claim).length,0);
 assert.equal(f.calls.filter(x=>x.sql?.includes("INSERT INTO messages")).length,0);
 assert.equal(f.calls.filter(x=>x.sql?.includes("UPDATE contacts")).length,0);
});
test("worker replays a staged sync only under the exact Ariel business identity",async()=>{
 const f=make();
 const staged={accountId:env.WHATSAPP_SECONDARY_WABA_ID,
  change:{field:"history",value}};
 const original=f.database.query;
 f.database.query=async(sql,args)=>{
  if(sql.startsWith("SELECT fingerprint FROM whatsapp_sender_coexistence_import_jobs"))
   return {rows:[{fingerprint:"a".repeat(64)}]};
  if(sql.includes("SET status='processing'")&&sql.includes("RETURNING payload,attempts"))
   return {rowCount:1,rows:[{payload:staged,attempts:1}]};
  return original(sql,args);
 };
 const result=await history.runOnce({database:f.database,env,conversations:f.conversations,maxJobs:1});
 assert.equal(result.processed,1);
 assert.ok(f.calls.some(x=>x.sql?.includes("status='completed',payload=NULL")));
 assert.equal(f.calls.filter(x=>x.claim).length,1);
});
