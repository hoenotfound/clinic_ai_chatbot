"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const billing=require("../src/db/whatsappSenderBillingGateRepo");
const cs=process.env.TEST_DATABASE_URL;
const env={
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
 WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
 WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
 WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED:"true",
 WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"true",
 WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"true",
 WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
};
test("migration 109 requires approved secondary MARKETING attempt for billable 48/72 template",{
 skip:!cs,
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="secondary_marketing_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const pool={
   async connect(){
    const c=new Client({connectionString:cs});await c.connect();
    await c.query("SET search_path TO "+schema);
    return{query:(...args)=>c.query(...args),release:()=>c.end()};
   },query:(...args)=>db.query(...args),
  };
  assert.equal(loadMigrations().at(-1).version,111);
  await runMigrations(pool,{quiet:true});
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('ariel','100000000000002','200000000000002','Ariel','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
   "VALUES('whatsapp','60125554444',$1) RETURNING id",[sender])).rows[0].id;
  const conversation=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60125554444',$2,'bound') RETURNING id",[sender,contact])).rows[0].id;
  const inbound=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
   "VALUES($1,'user','Please contact me about my treatment','wamid.test') RETURNING id",
   [contact])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
   [inbound,conversation]);
  const hash="a".repeat(64);
  await db.query(
   "INSERT INTO whatsapp_sender_marketing_followup_rules "+
   "(sender_id,slot_hours,enabled,template_name,language_code,template_signature,operator_billing_approved) "+
   "VALUES($1,48,TRUE,'approved_neutro_48','zh',$2,TRUE)",[sender,hash]);
  const meta={
   automatedSecondaryMarketingFollowup:true,
   senderKey:"ariel",slotHours:48,anchorMessageId:inbound,
   templateSignature:hash,name:"approved_neutro_48",language:"zh",
  };
  const message=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_template,is_automated_follow_up) "+
   "VALUES($1,'assistant','Approved reminder',$2::jsonb,TRUE) RETURNING id",
   [contact,JSON.stringify(meta)])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
   [message,conversation]);
  const attempt=(await db.query(
   "INSERT INTO whatsapp_sender_marketing_followup_attempts "+
   "(sender_id,contact_id,anchor_message_id,slot_hours,message_id,status) "+
   "VALUES($1,$2,$3,48,$4,'claimed') RETURNING id",
   [sender,contact,inbound,message])).rows[0].id;
  async function reserve(mid=message,e=env){
   return billing.reserveSecondaryBillingAttempt({
    contactId:contact,messageId:mid,billableAuthorized:true,expectedTemplateSignature:hash,
   },{database:pool,env:e});
  }
  await db.query("UPDATE whatsapp_sender_marketing_followup_attempts SET status='unknown' WHERE id=$1",[attempt]);
  assert.equal((await reserve()).code,"secondary_billing_template_review_unverified",
   "unknown job is never a fresh automated marketing authorization");
  await db.query("UPDATE whatsapp_sender_marketing_followup_attempts SET status='claimed' WHERE id=$1",[attempt]);
  assert.equal((await reserve(message,{...env,WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"false"})).code,
   "secondary_billing_template_review_unverified");
  await db.query("UPDATE messages SET whatsapp_template=$2::jsonb WHERE id=$1",
   [message,JSON.stringify({...meta,senderKey:"neutro"})]);
  assert.equal((await reserve()).code,"secondary_billing_template_review_unverified");
  await db.query("UPDATE messages SET whatsapp_template=$2::jsonb WHERE id=$1",[message,JSON.stringify(meta)]);
  const spoof=(await db.query(
   "INSERT INTO messages(contact_id,role,content,whatsapp_template,is_automated_follow_up) "+
   "VALUES($1,'assistant','Spoof',$2::jsonb,TRUE) RETURNING id",
   [contact,JSON.stringify(meta)])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",[spoof,conversation]);
  assert.equal((await reserve(spoof)).code,"secondary_billing_template_review_unverified");
  const good=await reserve();
  assert.equal(good.reserved,true);
  assert.equal(good.sendAuthorized,false);
  assert.equal((await reserve()).code,"secondary_billing_previous_send_unresolved");
  const audit=(await db.query("SELECT billing_authorization_source,billing_review_claim_hash "+
   "FROM whatsapp_sender_billing_attempts WHERE message_id=$1",[message])).rows[0];
  assert.equal(audit.billing_authorization_source,"operator_approved_marketing_template");
  assert.equal(audit.billing_review_claim_hash,null);
  assert.equal((await db.query("SELECT COUNT(*)::int n FROM whatsapp_free_only_send_gate")).rows[0].n,0);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
