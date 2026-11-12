"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const billing=require("../src/db/whatsappSenderBillingGateRepo");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const service=require("../src/services/whatsappSecondaryFollowUpService");
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
  assert.ok(loadMigrations().at(-1).version>=118);
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
  // Compile the secondary Day 4/Day 6 scheduler hint against PostgreSQL.
  // This is EXPLAIN only; it cannot authorize or send a message.
  await db.query("EXPLAIN "+marketing.EXTENDED_POTENTIAL_DUE_SQL,[
   "ariel","100000000000002","200000000000002",
   new Date(),"2026-11-01T00:00:00Z","ads_only","2026-11-01T00:00:00Z",
  ]);

  // Compile ALL changed secondary service and marketing selectors against
  // the migrated PostgreSQL schema. EXPLAIN is read-only; no provider send.
  await db.query("EXPLAIN "+service.CANDIDATES_SQL,[
    "ariel","100000000000002","200000000000002",
    new Date(),10,"2026-11-01T00:00:00Z","ads_only",
    "2026-11-01T00:00:00Z",null,
  ]);
  await db.query("EXPLAIN "+service.RECHECK_SQL,[
    contact,inbound,20,"ariel","100000000000002","200000000000002",
    "1","2026-11-01T00:00:00Z","ads_only",
    "2026-11-01T00:00:00Z",null,
  ]);
  await db.query("EXPLAIN "+service.POTENTIAL_DUE_SQL,[
    "ariel","100000000000002","200000000000002",
    new Date(),"2026-11-01T00:00:00Z","ads_only",
    "2026-11-01T00:00:00Z",null,
  ]);
  await db.query("EXPLAIN "+marketing.CANDIDATES_SQL,[
    "ariel","100000000000002","200000000000002",
    new Date(),10,"2026-11-01T00:00:00Z","ads_only",
    "2026-11-01T00:00:00Z",
  ]);
  await db.query("EXPLAIN "+marketing.RECHECK_SQL,[
    "ariel","100000000000002","200000000000002",
    new Date(),10,"2026-11-01T00:00:00Z","ads_only",
    "2026-11-01T00:00:00Z",
  ]);
  // Real PostgreSQL timestamp arithmetic for the 9D contact's delayed 6h
  // example; no historical attempts are opened or replayed.
  const due=await db.query(
    "SELECT GREATEST($1::timestamptz + INTERVAL '20 hours'," +
    " $2::timestamptz + INTERVAL '15 minutes') AS due_at, " +
    " ($1::timestamptz + INTERVAL '24 hours') AS expires_at",[
      "2026-11-10T12:36:14.753Z","2026-11-10T23:00:08Z",
    ]);
  assert.equal(due.rows[0].due_at.toISOString(),"2026-11-11T08:36:14.753Z");
  assert.ok(due.rows[0].due_at<due.rows[0].expires_at);

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


  // A customer replied after the 2h reminder. This creates a new verified
  // inbound anchor, while its own 2h repeat stays blocked for seven days.
  // The 6h reminder should inherit ONLY the accepted prior prerequisite.
  // All data below lives in the disposable migrated test schema.
  for(const slot of [2,6,20]){
   await db.query(
    "INSERT INTO whatsapp_sender_followup_rules "+
    "(sender_id,slot_hours,enabled,message_text) VALUES($1,$2,TRUE,'Test')",
    [sender,slot]);
  }
  const returningContact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
    "VALUES('whatsapp','60125555533',$1) RETURNING id",[sender])).rows[0].id;
  const returningConversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
    "VALUES($1,'60125555533',$2,'bound') RETURNING id",
    [sender,returningContact])).rows[0].id;
  const earlierInbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at) "+
    "VALUES($1,'user','Interested in 3D','wamid.reengage.early',NOW()-INTERVAL '3 hours') RETURNING id",
    [returningContact])).rows[0].id;
  const latestInbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at) "+
    "VALUES($1,'user','What is the treatment duration?','wamid.reengage.latest',NOW()-INTERVAL '30 minutes') RETURNING id",
    [returningContact])).rows[0].id;
  for(const id of [earlierInbound,latestInbound]){
   await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [id,returningConversation]);
  }
  await db.query(
    "INSERT INTO whatsapp_sender_followup_attempts "+
    "(sender_id,contact_id,anchor_message_id,slot_hours,status,claimed_at,completed_at) "+
    "VALUES($1,$2,$3,2,'accepted',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour')",
    [sender,returningContact,earlierInbound]);
  const firstServiceMessage=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,whatsapp_template,created_at) "+
    "VALUES($1,'assistant','3D care information','wamid.reengage.2h',"+
    "jsonb_build_object('automatedSecondaryFollowup',true,'treatmentInterest','3D 小颜术'),"+
    "NOW()-INTERVAL '1 hour') RETURNING id",[returningContact])).rows[0].id;
  await db.query(
    "UPDATE whatsapp_sender_followup_attempts SET message_id=$2 "+
    "WHERE sender_id=$1 AND contact_id=$3 AND anchor_message_id=$4 AND slot_hours=2",
    [sender,firstServiceMessage,returningContact,earlierInbound]);
  const priorStepSql=`
    SELECT previous_step.slot_hours,previous_step.completed_at
    FROM whatsapp_sender_followup_rules rule
    JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
    JOIN contacts c ON c.id=$2 AND c.whatsapp_sender_id=sa.id
    JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
      AND sc.contact_id=c.id AND sc.state='bound'
    JOIN messages inbound ON inbound.id=$3 AND inbound.contact_id=c.id
    ${service.PREVIOUS_STEP_SQL}
    WHERE rule.sender_id=$1 AND rule.slot_hours=$4
  `;
  const prerequisite=async slot=>(await db.query(priorStepSql,
    [sender,returningContact,latestInbound,slot])).rows[0];
  assert.equal(Number((await prerequisite(6)).slot_hours),2,
   "a genuine latest-inbound reply should retain the verified 2h stage");
  assert.ok((await prerequisite(6)).completed_at,
   "accepted previous 2h message can unlock the new 6h stage");
  assert.equal((await prerequisite(20)).completed_at,null,
   "20h cannot leapfrog an unaccepted 6h step");
  assert.equal((await db.query(
    "SELECT COUNT(*)::int n FROM whatsapp_sender_followup_attempts "+
    "WHERE contact_id=$1 AND slot_hours=2",[returningContact])).rows[0].n,1,
   "inheritance must never send a second 2h media message");

  // Staff intervention between accepted 2h and the new customer inbound
  // cannot be silently bypassed by inherited sequence history.
  const staffId=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,sent_by_username,created_at) "+
    "VALUES($1,'assistant','Please book with me','wamid.staff.reengagement','staff.test',"+
    "NOW()-INTERVAL '45 minutes') RETURNING id",[returningContact])).rows[0].id;
  assert.equal((await prerequisite(6)).completed_at,null,
   "staff involvement stops inherited reminders");
  await db.query("DELETE FROM messages WHERE id=$1",[staffId]);

  // A different, unconfirmed attempt while the customer was absent must
  // not authorize a stage via earlier accepted media.
  const heldId=(await db.query(
    "INSERT INTO whatsapp_sender_followup_attempts "+
    "(sender_id,contact_id,anchor_message_id,slot_hours,status,claimed_at,completed_at) "+
    "VALUES($1,$2,$3,6,'unknown',NOW()-INTERVAL '50 minutes',NOW()-INTERVAL '50 minutes') "+
    "RETURNING id",[sender,returningContact,earlierInbound])).rows[0].id;
  assert.equal((await prerequisite(6)).completed_at,null,
   "uncertain attempts block cross-anchor inheritance");
  await db.query("DELETE FROM whatsapp_sender_followup_attempts WHERE id=$1",[heldId]);

  // A new explicit selection of the SAME service is safe only if the
  // accepted old reminder saved an exact, immutable treatment snapshot.
  await db.query(
    "INSERT INTO whatsapp_sender_followup_treatment_state "+
    "(sender_id,contact_id,source_message_id,status,treatment_name) "+
    "VALUES($1,$2,$3,'selected','3D 小颜术')",
    [sender,returningContact,latestInbound]);
  assert.ok((await prerequisite(6)).completed_at,
   "same verified 3D service may continue after re-engagement");
  await db.query(
    "UPDATE whatsapp_sender_followup_treatment_state "+
    "SET treatment_name='9D 逆龄抗衰' WHERE sender_id=$1 AND contact_id=$2",
    [sender,returningContact]);
  assert.equal((await prerequisite(6)).completed_at,null,
   "new 9D selection prevents inheriting old 3D care media");
  await db.query(
    "DELETE FROM whatsapp_sender_followup_treatment_state "+
    "WHERE sender_id=$1 AND contact_id=$2",[sender,returningContact]);

  await db.query(
    "INSERT INTO whatsapp_sender_followup_attempts "+
    "(sender_id,contact_id,anchor_message_id,slot_hours,status,claimed_at,completed_at) "+
    "VALUES($1,$2,$3,6,'accepted',NOW()-INTERVAL '40 minutes',NOW()-INTERVAL '40 minutes')",
    [sender,returningContact,earlierInbound]);
  assert.equal(Number((await prerequisite(20)).slot_hours),6);
  assert.ok((await prerequisite(20)).completed_at,
   "20h can follow a verified 6h reminder across a genuine new inbound");

 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
