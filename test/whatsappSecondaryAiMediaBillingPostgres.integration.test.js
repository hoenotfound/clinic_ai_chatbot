"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const billing=require("../src/db/whatsappSenderBillingGateRepo");
const cs=process.env.TEST_DATABASE_URL;
const env={
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
 WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
 WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
 WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
 WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
};
test("real PostgreSQL reserves a legitimate claimed secondary AI graphic but rejects spoofed or cross-sender records",
 {skip:!cs},async()=>{
 const db=new Client({connectionString:cs});
 const schema="secondary_img_bill_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const pool={
   async connect(){
    const c=new Client({connectionString:cs});await c.connect();
    await c.query("SET search_path TO "+schema);
    return{query:(...args)=>c.query(...args),release:()=>c.end()};
   },
   query:(...args)=>db.query(...args),
  };
  await runMigrations(pool,{quiet:true});
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('ariel','100000000000002','200000000000002','Ariel','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) VALUES('whatsapp','60125554444',$1) RETURNING id",
   [sender])).rows[0].id;
  const conv=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60125554444',$2,'bound') RETURNING id",
   [sender,contact])).rows[0].id;
  const inbound=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Interested in 3D','wamid.real-secondary-inbound') RETURNING id",
   [contact])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
   [inbound,conv]);
  const imageUrl="/api/config/result-media/image/23";
  const metadata={automatedSecondaryAiMedia:true,senderKey:"ariel",anchorMessageId:inbound};
  const outbound=(await db.query(
   "INSERT INTO messages(contact_id,role,content,media_url,whatsapp_template,delivery_status) "+
   "VALUES($1,'assistant','Approved 3D result',$2,$3::jsonb,'unknown') RETURNING id",
   [contact,imageUrl,JSON.stringify(metadata)])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
   [outbound,conv]);
  const job=(await db.query(
   "INSERT INTO whatsapp_sender_ai_media_jobs(sender_id,contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption,state,outbound_message_id,expires_at) "+
   "VALUES($1,$2,$3,0,'result',$4,'Approved 3D result','pending',$5,NOW()+INTERVAL '1 hour') RETURNING id",
   [sender,contact,inbound,imageUrl,outbound])).rows[0].id;
  const reserve=(mid=outbound,cid=contact)=>billing.reserveSecondaryBillingAttempt({
   contactId:cid,messageId:mid,billableAuthorized:true,
  },{database:pool,env});
  assert.equal((await reserve()).code,"secondary_billing_template_review_unverified",
   "pending job is not a valid billable AI image");
  await db.query("UPDATE whatsapp_sender_ai_media_jobs SET state='claimed' WHERE id=$1",[job]);
  await db.query("UPDATE messages SET whatsapp_template=$2::jsonb WHERE id=$1",
   [outbound,JSON.stringify({...metadata,senderKey:"neutro"})]);
  assert.equal((await reserve()).code,"secondary_billing_template_review_unverified",
   "a primary/foreign sender marker cannot authorize secondary AI media");
  await db.query("UPDATE messages SET whatsapp_template=$2::jsonb WHERE id=$1",
   [outbound,JSON.stringify({...metadata,anchorMessageId:inbound+123})]);
  assert.equal((await reserve()).code,"secondary_billing_template_review_unverified",
   "an unrelated inbound anchor cannot be substituted");
  await db.query("UPDATE messages SET whatsapp_template=$2::jsonb WHERE id=$1",
   [outbound,JSON.stringify(metadata)]);
  const fake=(await db.query(
   "INSERT INTO messages(contact_id,role,content,media_url,whatsapp_template,delivery_status) "+
   "VALUES($1,'assistant','Forged media',$2,$3::jsonb,'unknown') RETURNING id",
   [contact,imageUrl,JSON.stringify(metadata)])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[fake,conv]);
  assert.equal((await reserve(fake)).code,"secondary_billing_template_review_unverified",
   "the exact outbound row must be attached to the real claimed image job");
  assert.equal((await reserve(outbound,contact+999)).code,"secondary_billing_sender_mismatch");
  const allowed=await reserve();
  assert.equal(allowed.reserved,true);
  assert.equal(allowed.sendAuthorized,false);
  assert.equal((await reserve()).code,"secondary_billing_previous_send_unresolved",
   "no repeated provider call after first reservation");
  const count=(await db.query(
   "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_attempts WHERE sender_id=$1",
   [sender])).rows[0].n;
  assert.equal(count,1);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate")).rows[0].n,0,
   "primary WhatsApp free-send table is untouched");
 } finally {
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
