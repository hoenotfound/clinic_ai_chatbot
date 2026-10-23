"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const coex=require("../src/services/whatsappCoexistenceMediaService");

const env={
 WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"110552088553929",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
};
const job={message_id:42,contact_id:12,sender_id:5,
 provider_media_id:"provider-media-123",media_type:"image",
 whatsapp_message_id:"wamid.app-echo-1",whatsapp_number:"60126662222"};
function fake({media=true,sender="ariel"}={}){
 const calls=[];
 const db={query:async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql===coex.READY_SQL)return{rows:[job]};
   if(sql.includes("status='claimed'")&&sql.includes("RETURNING attempts"))
     return{rowCount:1,rows:[{attempts:1}]};
   if(sql.startsWith("UPDATE messages m"))return{rowCount:1,rows:[{id:42}]};
   if(sql.includes("RETURNING status"))return{rowCount:1,rows:[{status:"review"}]};
   return{rowCount:1,rows:[]};
 }};
 const contacts={getContactById:async()=>({
   id:12,channel:"whatsapp",whatsapp_sender_id:5,
   whatsapp_sender_key:sender,whatsapp_number:job.whatsapp_number,
 })};
 const download=async(input)=>{
   calls.push({download:input});
   return media?{buffer:Buffer.from("jpeg"),mimeType:"image/jpeg"}:null;
 };
 const storage={uploadMedia:async(...args)=>{
   calls.push({stored:args});return"private/r2-media-path";
 }};
 return{database:db,contacts,download,storage,calls};
}
test("Business App echo media sync is off unless explicitly enabled",async()=>{
 assert.equal(coex.enabled({}),false);
 assert.equal(coex.enabled({...env,WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"false"}),false);
 const f=fake();
 assert.deepEqual(await coex.runOnce({...f,env:{}}),{disabled:true,processed:0,review:0});
 assert.equal(f.calls.length,0);
});
test("verified Ariel echo media is fetched by Ariel's receiver identity, stored privately, never sent",async()=>{
 const f=fake();
 const result=await coex.runOnce({...f,env});
 assert.deepEqual(result,{disabled:false,processed:1,review:0});
 assert.equal(f.calls.filter(x=>x.download).length,1);
 assert.equal(f.calls.filter(x=>x.stored).length,1);
 assert.equal(f.calls.find(x=>x.download).download.businessPhoneNumberId,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
 assert.equal(f.calls.find(x=>x.download).download.businessAccountId,env.WHATSAPP_SECONDARY_WABA_ID);
 assert.equal(f.calls.find(x=>x.stored).stored[2].contactId,12);
 assert.ok(f.calls.some(x=>x.sql?.includes("status='complete'")));
 assert.ok(f.calls.every(x=>!x.sql?.includes("INSERT INTO whatsapp_sender_billing")));
});
test("wrong sender or unavailable media leaves staff-visible placeholder for review",async()=>{
 for(const mock of [fake({media:false}),fake({sender:"neutro"})]){
   const result=await coex.runOnce({...mock,env});
   assert.equal(result.review,1);
   assert.equal(result.processed,0);
   assert.equal(mock.calls.filter(x=>x.stored).length,0);
 }
});
test("media event enqueue fails closed for wrong identity or no explicit flag",async()=>{
 const f=fake();
 assert.equal(await coex.enqueue({contactId:12,messageId:42,
   wamid:"wamid.app-echo-1",mediaId:"m123",type:"image"},{database:f.database,env:{}}),false);
 assert.equal(await coex.enqueue({contactId:12,messageId:42,
   wamid:"wamid.app-echo-1",mediaId:"",type:"image"},{database:f.database,env}),false);
 assert.equal(f.calls.length,0);
 assert.match(coex.READY_SQL,/sc\.customer_wa_id=c\.whatsapp_number/);
 assert.match(coex.READY_SQL,/m\.sent_by_username='WhatsApp Business App'/);
});
