"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const queue=require("../src/services/whatsappSecondaryAiMediaQueue");
const audit=require("../src/services/whatsappSecondaryAiMediaAudit");
const connectionString=process.env.TEST_DATABASE_URL;
const env={
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
 WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
 WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
 WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
 WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
 WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
 WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
};
test("secondary media audit and contact wake operate on isolated PostgreSQL evidence",{
 skip:!connectionString,
},async()=>{
 const db=new Client({connectionString});
 const schema="secondary_media_outcome_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
   await db.query("CREATE SCHEMA "+schema);
   await db.query("SET search_path TO "+schema);
   const database={
     query:(...a)=>db.query(...a),
     async connect(){
       const c=new Client({connectionString});await c.connect();
       await c.query("SET search_path TO "+schema);
       return{query:(...a)=>c.query(...a),release:()=>c.end()};
     }
   };
   await runMigrations(database,{quiet:true});
   const sender=Number((await db.query(
     "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
     "VALUES('neutro_secondary','100000000000002','200000000000002','Secondary','active') RETURNING id"
   )).rows[0].id);
   const ids=[];
   for(const [number,caption] of [["60120010001","Result A"],["60120010002","Result B"]]){
     const contact=Number((await db.query(
       "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) VALUES('whatsapp',$1,$2) RETURNING id",
       [number,sender])).rows[0].id);
     const inbound=Number((await db.query(
       "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
       "VALUES($1,'user','Please explain treatment',$2) RETURNING id",
       [contact,"wamid.inbound-"+number])).rows[0].id);
     const job=Number((await db.query(
       "INSERT INTO whatsapp_sender_ai_media_jobs "+
       "(sender_id,contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption,state,next_attempt_at,expires_at) "+
       "VALUES($1,$2,$3,0,'result','https://example.test/image.jpg',$4,'pending',NOW()+INTERVAL '90 seconds',NOW()+INTERVAL '2 hours') RETURNING id",
       [sender,contact,inbound,caption])).rows[0].id);
     await db.query("INSERT INTO whatsapp_sender_billing_gates(sender_id,owner_contact_id) VALUES($1,$2)",[sender,contact]);
     ids.push({contact,inbound,job});
   }
   const [one,two]=ids;
   assert.equal(await queue.wakeAfterVerifiedReconciliation({contactIds:[one.contact],database,env}),true);
   const wakeRows=(await db.query(
     "SELECT contact_id,next_attempt_at<=NOW() AS due FROM whatsapp_sender_ai_media_jobs ORDER BY id"
   )).rows;
   assert.deepEqual(wakeRows.map(x=>x.due),[true,false],
     "Customer B's idle billing gate must not wake Customer A's unrelated image");

   assert.equal(await audit.reconcileSecondaryMediaAudit({
     inboundMessageIds:[one.inbound,two.inbound],database,env,
   }),2);
   const initial=(await db.query("SELECT status,reason FROM result_media_decisions WHERE inbound_message_id=$1",
     [one.inbound])).rows[0];
   assert.deepEqual(initial,{status:"deferred",reason:"awaiting_sender_billing_receipt"});

   await db.query("UPDATE whatsapp_sender_ai_media_jobs SET state='expired' WHERE id=$1",[one.job]);
   assert.equal(await audit.reconcileRecentTerminalMediaAudit({database,env}),1,
     "startup repair fixes historical expired images without touching the pending customer");
   assert.deepEqual((await db.query("SELECT status,reason,result_images_selected,result_images_sent "+
     "FROM result_media_decisions WHERE inbound_message_id=$1",[one.inbound])).rows[0],
     {status:"skipped",reason:"secondary_media_cancelled_before_send",
       result_images_selected:1,result_images_sent:0});

   const ambiguous=Number((await db.query(
     "INSERT INTO messages(contact_id,role,content,media_url,delivery_status) "+
     "VALUES($1,'assistant','Ambiguous image','https://example.test/image.jpg','unknown') RETURNING id",
     [one.contact])).rows[0].id);
   await db.query("UPDATE whatsapp_sender_ai_media_jobs SET outbound_message_id=$2 WHERE id=$1",
     [one.job,ambiguous]);
   await audit.reconcileSecondaryMediaAudit({inboundMessageIds:[one.inbound],database,env});
   assert.equal((await db.query("SELECT reason FROM result_media_decisions WHERE inbound_message_id=$1",
     [one.inbound])).rows[0].reason,"secondary_media_outcome_unconfirmed",
     "an expired job with an unknown local message must not be reported as safely cancelled");

   const outbound=Number((await db.query(
     "INSERT INTO messages(contact_id,role,content,media_url,delivery_status,whatsapp_message_id) "+
     "VALUES($1,'assistant','Result B','https://example.test/image.jpg','sent','wamid.secondary-b') RETURNING id",
     [two.contact])).rows[0].id);
   await db.query("UPDATE whatsapp_sender_ai_media_jobs SET state='accepted',outbound_message_id=$2,accepted_wamid='wamid.secondary-b' WHERE id=$1",
     [two.job,outbound]);
   await audit.reconcileSecondaryMediaAudit({inboundMessageIds:[two.inbound],database,env});
   assert.deepEqual((await db.query("SELECT status,reason,result_images_sent FROM result_media_decisions WHERE inbound_message_id=$1",
     [two.inbound])).rows[0],
     {status:"deferred",reason:"secondary_media_waiting_delivery_receipt",result_images_sent:0},
     "A Meta WAMID is not proof of customer delivery");

   await db.query("UPDATE messages SET delivery_status='delivered' WHERE id=$1",[outbound]);
   await audit.reconcileSecondaryMediaAudit({inboundMessageIds:[two.inbound],database,env});
   assert.deepEqual((await db.query("SELECT status,reason,result_images_sent FROM result_media_decisions WHERE inbound_message_id=$1",
     [two.inbound])).rows[0],
     {status:"sent",reason:"secondary_media_delivered",result_images_sent:1});

   await db.query("UPDATE whatsapp_sender_ai_media_jobs SET state='unknown' WHERE id=$1",[one.job]);
   await audit.reconcileSecondaryMediaAudit({inboundMessageIds:[one.inbound],database,env});
   assert.equal((await db.query("SELECT reason FROM result_media_decisions WHERE inbound_message_id=$1",
     [one.inbound])).rows[0].reason,"secondary_media_outcome_unconfirmed");
   assert.equal((await db.query("SELECT count(*)::int n FROM whatsapp_sender_billing_attempts")).rows[0].n,0,
     "audit and billing wake do not reserve or send anything");
 }finally{
   await db.query("SET search_path TO public").catch(()=>{});
   await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
   await db.end();
 }
});


test("all-contact secondary activation reconciles expired media and old generic-skip audits",async()=>{
 const allContactsEnv={
   ...env,
   WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-02T00:00:00Z",
   WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-02T00:00:00Z",
 };
 const calls=[];
 const database={query:async(sql,args)=>{
   calls.push({sql,args});
   if(sql===audit.RECENT_TERMINAL_SQL)return{rows:[{inbound_message_id:17919}],rowCount:1};
   if(sql===audit.RECONCILE_SQL)return{rows:[{inbound_message_id:17919,status:"partial"}],rowCount:1};
   assert.fail("Unexpected audit query");
 }};
 const repaired=await audit.reconcileRecentTerminalMediaAudit({
   database,env:allContactsEnv,
 });
 assert.equal(repaired,1);
 assert.equal(calls.length,2);
 assert.match(calls[0].sql,/j\.state='expired' AND d\.status='skipped'/);
 assert.match(calls[0].sql,/d\.reason NOT LIKE 'secondary_media_%'/);
 assert.deepEqual(calls[1].args[0],[17919]);
 assert.deepEqual(calls[1].args.slice(1),[
   "neutro_secondary",allContactsEnv.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   allContactsEnv.WHATSAPP_SECONDARY_WABA_ID,
 ]);
 assert.equal(await audit.reconcileSecondaryMediaAudit({
   inboundMessageIds:[17919],database,
   env:{...allContactsEnv,WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:""},
 }),0,"invalid automation cutover must not write an audit");
});

test("real all-contact PostgreSQL queue chooses newest plan, preserves benign questions, and blocks clinical media",{
 skip:!connectionString,
},async()=>{
 const allEnv={
   ...env,WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-02T00:00:00Z",
   WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-02T00:00:00Z",
 };
 const db=new Client({connectionString});
 const schema="secondary_media_priority_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
   await db.query("CREATE SCHEMA "+schema);
   await db.query("SET search_path TO "+schema);
   const database={
     query:(...args)=>db.query(...args),
     async connect(){
       const c=new Client({connectionString});await c.connect();
       await c.query("SET search_path TO "+schema);
       return {query:(...args)=>c.query(...args),release:()=>c.end()};
     },
   };
   await runMigrations(database,{quiet:true});
   const sender=Number((await db.query(
     "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
     "VALUES('neutro_secondary','100000000000002','200000000000002','Secondary','active') RETURNING id",
   )).rows[0].id);
   let serial=0;
   async function makeConversation(nextText,{newPlan=false}={}){
     const number="6012"+String(++serial).padStart(7,"0");
     const contact=Number((await db.query(
       "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
       "VALUES('whatsapp',$1,$2) RETURNING id",[number,sender],
     )).rows[0].id);
     const conversation=Number((await db.query(
       "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
       "VALUES($1,$2,$3,'bound') RETURNING id",[sender,number,contact],
     )).rows[0].id);
     const inbound=Number((await db.query(
       "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,source_created_at) "+
       "VALUES($1,'user','我想了解骨盆调理',$2,NOW()) RETURNING id",
       [contact,"wamid.original."+serial],
     )).rows[0].id);
     await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) "+
       "VALUES($1,$2)",[inbound,conversation]);
     const oldJob=Number((await db.query(
       "INSERT INTO whatsapp_sender_ai_media_jobs(sender_id,contact_id,inbound_message_id,"+
       "sequence_no,media_kind,image_url,caption,state,next_attempt_at,expires_at) "+
       "VALUES($1,$2,$3,0,'result','https://example.test/pelvic-result.jpg',"+
       "'Pelvic result','pending',NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour') "+
       "RETURNING id",[sender,contact,inbound],
     )).rows[0].id);
     const follow=Number((await db.query(
       "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,source_created_at) "+
       "VALUES($1,'user',$2,$3,NOW()) RETURNING id",
       [contact,nextText,"wamid.next."+serial],
     )).rows[0].id);
     await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) "+
       "VALUES($1,$2)",[follow,conversation]);
     let newJob=null;
     if(newPlan){
       newJob=Number((await db.query(
         "INSERT INTO whatsapp_sender_ai_media_jobs(sender_id,contact_id,inbound_message_id,"+
         "sequence_no,media_kind,image_url,caption,state,next_attempt_at,expires_at) "+
         "VALUES($1,$2,$3,0,'promotion','https://example.test/pelvic-package.jpg',"+
         "'Pelvic package','pending',NOW()-INTERVAL '1 minute',NOW()+INTERVAL '1 hour') "+
         "RETURNING id",[sender,contact,follow],
       )).rows[0].id);
     }
     return{contact,inbound,oldJob,follow,newJob};
   }
   const location=await makeConversation("Location");
   const method=await makeConversation("是徒手吗");
   const price=await makeConversation("想要了解价钱",{newPlan:true});
   const clinical=await makeConversation("我是腹直肌分离");
   const newer=await makeConversation("Location",{newPlan:true});
   const args=[allEnv.WHATSAPP_SECONDARY_SENDER_KEY,
     allEnv.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
     allEnv.WHATSAPP_SECONDARY_WABA_ID,20,
     allEnv.WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT,
     "all_contacts",allEnv.WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT];
   // Exercise priority independently of the actual Malaysia clock. The
   // production READY_SQL still forbids all sends during 00:00-06:59 MYT.
   const quietHoursRule=
     "EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23";
   assert.ok(queue.READY_SQL.includes(quietHoursRule));
   const prioritySql=queue.READY_SQL.replace(quietHoursRule,
     "EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 0 AND 23");
   const ready=(await db.query(prioritySql,args)).rows.map(r=>Number(r.id));
   assert.ok(ready.includes(location.oldJob),"location preserves the media plan");
   assert.ok(ready.includes(method.oldJob),"manual method question preserves media");
   assert.ok(!ready.includes(price.oldJob),"price question retires old results");
   assert.ok(ready.includes(price.newJob),"new price plan takes priority");
   assert.ok(!ready.includes(clinical.oldJob),"clinical concern blocks media");
   assert.ok(!ready.includes(newer.oldJob),"new media plan replaces older media");
   assert.ok(ready.includes(newer.newJob));
   const cleaned=await queue.cancelObsoletePending({database,env:allEnv});
   assert.equal(cleaned.cancelled,3);
   const states=(await db.query("SELECT id,state FROM whatsapp_sender_ai_media_jobs")).rows;
   const s=new Map(states.map(row=>[Number(row.id),row.state]));
   assert.equal(s.get(location.oldJob),"pending");
   assert.equal(s.get(method.oldJob),"pending");
   assert.equal(s.get(price.oldJob),"expired");
   assert.equal(s.get(price.newJob),"pending");
   assert.equal(s.get(clinical.oldJob),"expired");
   assert.equal(s.get(newer.oldJob),"expired");
   assert.equal(s.get(newer.newJob),"pending");
   const auditRows=(await db.query(
     "SELECT inbound_message_id,status,reason FROM result_media_decisions "+
     "WHERE inbound_message_id=ANY($1::int[])",[[price.inbound,clinical.inbound,newer.inbound]],
   )).rows;
   assert.equal(auditRows.length,3);
   for(const row of auditRows){
     assert.equal(row.status,"skipped");
     assert.equal(row.reason,"secondary_media_cancelled_before_send");
   }
   assert.equal((await db.query(
     "SELECT COUNT(*)::int n FROM whatsapp_sender_billing_attempts",
   )).rows[0].n,0,"cleanup cannot call Meta or reserve billing");
 }finally{
   await db.query("SET search_path TO public").catch(()=>{});
   await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
   await db.end();
 }
});
