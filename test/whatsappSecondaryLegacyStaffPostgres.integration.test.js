"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const {isSecondaryAiReplyEligible,eligibleSecondaryAiReplyContactIds,isSecondaryAutomationEligible}=
 require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const cs=process.env.TEST_DATABASE_URL;
test("migrated Postgres: older contact stays staff-only until a fresh verified secondary CTWA ad",{
 skip:!cs
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="secondary_legacy_staff_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const migrator={async connect(){
   const c=new Client({connectionString:cs});await c.connect();
   await c.query("SET search_path TO "+schema);
   return{query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  await runMigrations(migrator,{quiet:true});
  const phoneId="100000000001045",accountId="200000000001045";
  const sender=(await db.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
   "VALUES('neutro_secondary',$1,$2,'Secondary','active') RETURNING id",
   [phoneId,accountId])).rows[0].id;
  const cutoff=new Date(Date.now()-120000).toISOString();
  const env={
   WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:new Date(Date.now()-3600000).toISOString(),
   WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED:"true",
   WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:cutoff,
   WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:phoneId,
   WHATSAPP_SECONDARY_WABA_ID:accountId,
   WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
   WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
   WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
   WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:cutoff,
   WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:cutoff,
   WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:new Date(Date.now()-3600000).toISOString(),
  };
  const older=(await db.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
   "VALUES('whatsapp','60123499045',$1,NOW()-INTERVAL '2 years') RETURNING id",
   [sender])).rows[0].id;
  const newer=(await db.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
   "VALUES('whatsapp','60123499046',$1,NOW()) RETURNING id",
   [sender])).rows[0].id;
  const conv=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60123499045',$2,'bound') RETURNING id",[sender,older])).rows[0].id;
  const newerConv=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60123499046',$2,'bound') RETURNING id",[sender,newer])).rows[0].id;
  let seq=0;
  async function inbound(id,conversation,content){
   seq++;
   const m=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user',$2,$3,NOW(),NOW()) RETURNING id",
    [id,content,"wamid.legacy-test-"+seq])).rows[0].id;
   await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [m,conversation]);
   return m;
  }
  const direct=await inbound(older,conv,"Hi I want to know prices");
  assert.equal(await isSecondaryAiReplyEligible(older,{database:db,env,inboundMessageId:direct}),false,
   "new direct text from an old contact remains staff-managed");
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([older],{database:db,env})],[]);
  const newDirect=await inbound(newer,newerConv,"Hello");
  assert.equal(await isSecondaryAiReplyEligible(newer,{database:db,env,inboundMessageId:newDirect}),true,
   "a genuinely new secondary contact may use the existing all-contact AI audience");

  // An earlier, genuine ad is not enough to reopen an older customer.
  // A NEW readable sender-bound inbound after cutover can resume AI within
  // seven days of that ad, without pretending the new message was itself an ad.
  const returning=(await db.query(
   "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
   "VALUES('whatsapp','60123499048',$1,NOW()-INTERVAL '2 years') RETURNING id",
   [sender])).rows[0].id;
  const returningConv=(await db.query(
   "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
   "VALUES($1,'60123499048',$2,'bound') RETURNING id",
   [sender,returning])).rows[0].id;
  const priorAd=await inbound(returning,returningConv,"Hello from a verified earlier ad");
  await db.query(
   "UPDATE messages SET created_at=$2::timestamptz-INTERVAL '10 minutes', "+
   "source_created_at=$2::timestamptz-INTERVAL '10 minutes' WHERE id=$1",
   [priorAd,cutoff]);
  await db.query(
   "INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,meta_ad_id,source_type) "+
   "VALUES($1,$2,'old-verified-ad','ad')",[priorAd,returning]);
  assert.equal(await isSecondaryAiReplyEligible(returning,{
   database:db,env,inboundMessageId:priorAd
  }),false,"the original pre-cutover ad never replays a reply");
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([returning],{database:db,env})],[],
   "original ad alone leaves the historical customer paused");
  const unreadableReturn=await inbound(returning,returningConv,
   "📎 [Customer sent a WhatsApp message that could not be displayed]");
  assert.equal(await isSecondaryAiReplyEligible(returning,{
   database:db,env,inboundMessageId:unreadableReturn
  }),false,"an unreadable new message cannot renew old ad eligibility");
  const returned=await inbound(returning,returningConv,"Hi, can you explain the treatment?");
  assert.equal(await isSecondaryAiReplyEligible(returning,{
   database:db,env,inboundMessageId:returned
  }),true,"fresh readable inbound within the original ad window reopens AI");
  assert.equal(await isSecondaryAutomationEligible(returning,{
   database:db,env,inboundMessageId:returned
  }),true,"normal eligible service follow-ups can resume with new inbound");
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([returning],{database:db,env})],[returning],
   "Inbox reflects re-entry only after the new readable inbound");
  await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[returning]);
  assert.equal(await isSecondaryAiReplyEligible(returning,{
   database:db,env,inboundMessageId:returned
  }),false,"explicit human takeover always wins");
  await db.query("UPDATE contacts SET mode='ai',whatsapp_opt_out_at=NOW() WHERE id=$1",[returning]);
  assert.equal(await isSecondaryAiReplyEligible(returning,{
   database:db,env,inboundMessageId:returned
  }),false,"opt-outs still prohibit re-entry");

  // A returning staff-managed patient receives the one provider-verified
  // 131060 recovery menu. No ad referral is claimed. The placeholder itself
  // never grants AI or follow-up permissions until the patient replies.
  const recoveryOld=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
    "VALUES('whatsapp','60123499047',$1,NOW()-INTERVAL '3 years') RETURNING id",
    [sender])).rows[0].id;
  const recoveryConv=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
    "VALUES($1,'60123499047',$2,'bound') RETURNING id",
    [sender,recoveryOld])).rows[0].id;
  const recoveryMissing=await inbound(recoveryOld,recoveryConv,
    "📎 [Customer sent a WhatsApp message that could not be displayed]");
  assert.equal(await isSecondaryAiReplyEligible(recoveryOld,{
    database:db,env,inboundMessageId:recoveryMissing
  }),false,"no old-contact AI solely from unreadable content");
  const recoveryMenu=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,delivery_status) "+
    "VALUES($1,'assistant',$2,'wamid.recovery-menu',NOW(),'delivered') RETURNING id",
    [recoveryOld,"Hi～欢迎来到 Neutro Sense 😊\\n\\n想了解哪方面的护理呢？\\n可以点下面的选项～"]
  )).rows[0].id;
  await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [recoveryMenu,recoveryConv]);
  await db.query(
    "INSERT INTO outbound_message_evidence(message_id,contact_id,channel,origin,accepted,provider_message_id,accepted_at) "+
    "VALUES($1,$2,'whatsapp','system_fallback',TRUE,'wamid.recovery-menu',NOW())",
    [recoveryMenu,recoveryOld]);
  assert.equal(await isSecondaryAutomationEligible(recoveryOld,{
    database:db,env,inboundMessageId:recoveryMissing
  }),true,"after provider acceptance, the unavailable inbound can anchor safe recovery reminders");
  assert.equal(await isSecondaryAiReplyEligible(recoveryOld,{
    database:db,env,inboundMessageId:recoveryMissing
  }),true,"accepted 131060 recovery also keeps the initial conversation eligible for a neutral reminder");
  // The unreadable turn still has no treatment, advertisement or marketing consent.
  assert.equal((await db.query(
    "SELECT COUNT(*)::int AS n FROM whatsapp_free_entry_referrals WHERE contact_id=$1",
    [recoveryOld])).rows[0].n,0);
  const readable=await inbound(recoveryOld,recoveryConv,"骨盆调理");
  assert.equal(await isSecondaryAiReplyEligible(recoveryOld,{
    database:db,env,inboundMessageId:readable
  }),true,"the verified recovery menu and readable customer reply restore AI");
  assert.equal(await isSecondaryAutomationEligible(recoveryOld,{
    database:db,env,inboundMessageId:readable
  }),true,"the readable treatment choice is now eligible for service follow-up");
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([recoveryOld],{
    database:db,env})],[recoveryOld],
    "Inbox recognizes AI re-entry only after accepted 131060 recovery menu");
  await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[recoveryOld]);
  assert.equal(await isSecondaryAiReplyEligible(recoveryOld,{
    database:db,env,inboundMessageId:readable
  }),false,"direct human takeover still overrides recovered AI");
  await db.query("UPDATE contacts SET mode='ai' WHERE id=$1",[recoveryOld]);

  const unsupported=await inbound(older,conv,"📎 [Customer sent a WhatsApp message that could not be displayed]");
  assert.equal(await isSecondaryAiReplyEligible(older,{database:db,env,inboundMessageId:unsupported}),false,
   "a bare Meta 131060 placeholder never fabricates a CTWA session");
  await db.query(
   "INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,meta_ad_id,source_type) "+
   "VALUES($1,$2,'999888777','ad')",[unsupported,older]);
  assert.equal(await isSecondaryAiReplyEligible(older,{database:db,env,inboundMessageId:unsupported}),true,
   "a genuine new referral on the same provider-bound unavailable message restores AI eligibility");
  const continued=await inbound(older,conv,"骨盆调理");
  assert.equal(await isSecondaryAiReplyEligible(older,{database:db,env,inboundMessageId:continued}),true);
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([older],{database:db,env})],[older]);
  await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[older]);
  assert.equal(await isSecondaryAiReplyEligible(older,{database:db,env,inboundMessageId:continued}),false,
   "explicit human takeover still wins even after a new ad");
  await db.query("UPDATE contacts SET mode='ai',whatsapp_opt_out_at=NOW() WHERE id=$1",[older]);
  assert.equal(await isSecondaryAiReplyEligible(older,{database:db,env,inboundMessageId:continued}),false);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
