"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const billing=require("../src/db/whatsappSenderBillingGateRepo");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
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
test("approved secondary marketing billing requires one claimed attempt for each supported slot",{
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
  assert.equal(loadMigrations().at(-1).version,116);
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
  // Migration 114 fixes the previously broken 66h attempt slot and accepts
  // Day 4/Day 6 in BOTH sender rules and one-shot attempt tables. These test
  // rows do not authorize sends or touch any live account.
  for(const slot of [66,96,144]){
   await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_rules "+
    "(sender_id,slot_hours,enabled,template_name,language_code,template_signature,operator_billing_approved) "+
    "VALUES($1,$2,FALSE,'reviewed_future', 'zh_CN',$3,FALSE)",[sender,slot,hash]);
   await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_attempts "+
    "(sender_id,contact_id,anchor_message_id,slot_hours) VALUES($1,$2,$3,$4)",
    [sender,contact,inbound,slot]);
  }
  // Compile the extended read-only candidate query against a real migrated
  // Postgres schema; no eligible contact or provider send is required.
  await db.query("EXPLAIN "+marketing.EXTENDED_CANDIDATES_SQL,[
   "ariel","100000000000002","200000000000002",
   new Date(),10,"2026-11-01T00:00:00Z","ads_only","2026-11-01T00:00:00Z",
  ]);
  await db.query("EXPLAIN "+marketing.EXTENDED_RECHECK_SQL,[
   "ariel","100000000000002","200000000000002",
   new Date(),10,"2026-11-01T00:00:00Z","ads_only","2026-11-01T00:00:00Z",
  ]);
  const later=(await db.query(
   "SELECT slot_hours FROM whatsapp_sender_marketing_followup_attempts "+
   "WHERE sender_id=$1 ORDER BY slot_hours",[sender])).rows;
  assert.deepEqual(later.map(r=>Number(r.slot_hours)),[66,96,144]);

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

  // Every configured slot must pass the same sender-owned, claimed-attempt
  // billing checks. Independent contacts prevent one held reservation from
  // interfering with another test case. The 72-hour legacy slot stays valid.
  for (const slot of [66,72,96,144]) {
   const waId="6012555"+String(slot).padStart(4,"0");
   const templateName="approved_neutro_"+slot;
   await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_rules "+
    "(sender_id,slot_hours,enabled,template_name,language_code,template_signature,operator_billing_approved) "+
    "VALUES($1,$2,TRUE,$3,'zh_CN',$4,TRUE) "+
    "ON CONFLICT (sender_id,slot_hours,language_code) DO UPDATE SET "+
    "enabled=EXCLUDED.enabled,template_name=EXCLUDED.template_name,"+
    "template_signature=EXCLUDED.template_signature,"+
    "operator_billing_approved=EXCLUDED.operator_billing_approved",
    [sender,slot,templateName,hash]);
   const nextContact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
    "VALUES('whatsapp',$1,$2) RETURNING id",[waId,sender])).rows[0].id;
   const nextConversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
    "VALUES($1,$2,$3,'bound') RETURNING id",
    [sender,waId,nextContact])).rows[0].id;
   const nextInbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) "+
    "VALUES($1,'user','Please contact me about my treatment',$2) RETURNING id",
    [nextContact,"wamid.inbound_"+slot])).rows[0].id;
   await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [nextInbound,nextConversation]);
   const nextMeta={
    automatedSecondaryMarketingFollowup:true,
    senderKey:"ariel",slotHours:slot,anchorMessageId:nextInbound,
    templateSignature:hash,name:templateName,language:"zh_CN",
   };
   const nextMessage=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_template,is_automated_follow_up) "+
    "VALUES($1,'assistant','Approved reminder',$2::jsonb,TRUE) RETURNING id",
    [nextContact,JSON.stringify(nextMeta)])).rows[0].id;
   await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [nextMessage,nextConversation]);
   const reserveSlot=()=>billing.reserveSecondaryBillingAttempt({
    contactId:nextContact,messageId:nextMessage,billableAuthorized:true,
    expectedTemplateSignature:hash,
   },{database:pool,env});
   assert.equal((await reserveSlot()).code,"secondary_billing_template_review_unverified",
    slot+"h must not send without a claimed, linked attempt");
   await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_attempts "+
    "(sender_id,contact_id,anchor_message_id,slot_hours,message_id,status) "+
    "VALUES($1,$2,$3,$4,$5,'claimed')",
    [sender,nextContact,nextInbound,slot,nextMessage]);
   const authorized=await reserveSlot();
   assert.equal(authorized.reserved,true,slot+"h should reserve billing safely");
   assert.equal(authorized.sendAuthorized,false,"reservation is never send authorization");
   assert.equal((await reserveSlot()).code,"secondary_billing_previous_send_unresolved",
    "cannot reserve the same message twice");
   const auditSlot=(await db.query(
    "SELECT billing_authorization_source FROM whatsapp_sender_billing_attempts "+
    "WHERE message_id=$1",[nextMessage])).rows[0];
   assert.equal(auditSlot.billing_authorization_source,"operator_approved_marketing_template");
  }

 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
