"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const {normalizeTemplate,templateSignature}=require("../src/services/whatsappTemplateService");
for(const [key,value] of Object.entries({
 WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT:"2026-11-12T03:28:30.879Z",
 WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
 WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"2026-11-12T03:28:30.879Z",
}))process.env[key]=value;
const general=require("../src/services/neutroSecondaryGeneralMarketingSql");
const {APPROVED,pinned}=require("../src/services/neutroSecondaryGeneralMarketingTemplates");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const secondaryPolicy=require("../src/services/whatsappSecondaryPolicyService");

test("exactly 12 separately approved static marketing templates are pinned",()=>{
 assert.equal(Object.keys(APPROVED).length,4);
 for(const slot of [48,66,96,144])for(const lang of ["zh_CN","en_US","ms"]){
  const expected=pinned(slot,lang);
  assert.ok(expected && expected.signature && expected.id);
  assert.ok(expected.body.length>45 && expected.body.length<1024);
  assert.doesNotMatch(expected.body,/STOP PROMOTIONS|停止优惠|停止優惠|Balas STOP/i);
  const equivalent=normalizeTemplate({id:expected.id,name:expected.name,
    language:expected.language,status:"APPROVED",category:"MARKETING",
    components:[{type:"BODY",text:expected.body}]});
  assert.equal(expected.signature,templateSignature(equivalent));
  assert.equal(equivalent.sendable,true);
 }
 assert.equal(pinned(72,"zh_CN"),null);
 assert.equal(pinned(48,"fr"),null);
});

test("generic marketing requires separately enabled switch and explicit billing acknowledgement",()=>{
 const activation="2026-11-12T07:00:00.000Z";
 const base={WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT:activation,
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED:"true",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
  WHATSAPP_SECONDARY_ALL_AI_REPLY_ACTIVATED_AT:activation,
  WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:activation,
 };
 assert.equal(general.activation(base),activation);
 assert.equal(general.enabled({...base,WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED:"false"}),false);
 assert.equal(general.enabled({...base,WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED:"false"}),false);
 assert.equal(general.activation({...base,WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT:"yesterday"}),null);
 assert.match(general.CANDIDATES_SQL,/e\.consent_scope='general_clinic_followups_and_related_offers'/);
 assert.match(general.CANDIDATES_SQL,/accepted_menu\.accepted=TRUE/);
 assert.match(general.CANDIDATES_SQL,/recovery\.delivery_status IN/);
 assert.match(general.CANDIDATES_SQL,/e\.consented_at>=\$9::timestamptz/);
 assert.match(general.CANDIDATES_SQL,/c\.takeover_by IS NULL/);
 assert.match(general.CANDIDATES_SQL,/whatsapp_marketing_opt_out_at IS NULL/);
 assert.match(general.CANDIDATES_SQL,/whatsapp_sender_marketing_followup_attempts attempted/);
 assert.match(general.RECHECK_SQL,/attempted\.status='claimed'/);
 assert.match(secondaryPolicy.SECONDARY_GENERIC_MARKETING_CONSENT_SQL,/e\.consent_scope='general_clinic_followups_and_related_offers'/);
 assert.doesNotMatch(marketing.CANDIDATES_SQL,/general_campaign/);
});

const cs=process.env.TEST_DATABASE_URL;
test("general 48h/66h/Day4/Day6 candidate, recheck and scheduler SQL compile against migrated PostgreSQL",{
 skip:!cs,
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="neutro_generic_six_day_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const migrations={async connect(){const c=new Client({connectionString:cs});await c.connect();
   await c.query("SET search_path TO "+schema);
   return {query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  await runMigrations(migrations,{quiet:true});
  try{
   await db.query("PREPARE generic_candidates(text,text,text,timestamptz,integer,timestamptz,text,timestamptz,timestamptz) AS "+general.CANDIDATES_SQL);
  }catch(err){
   const pos=Number(err.position)||0;
   console.error("Generic SQL compile failure at",pos,JSON.stringify(general.CANDIDATES_SQL.slice(Math.max(0,pos-300),pos+250)));
   throw err;
  }
  await db.query("PREPARE generic_recheck(text,text,text,timestamptz,integer,timestamptz,text,timestamptz,timestamptz) AS "+general.RECHECK_SQL);
  await db.query("PREPARE generic_due(text,text,text,timestamptz,timestamptz,text,timestamptz,timestamptz) AS "+general.POTENTIAL_DUE_SQL);
  await db.query("PREPARE generic_consent(integer,integer,timestamptz) AS "+secondaryPolicy.SECONDARY_GENERIC_MARKETING_CONSENT_SQL);
  const args="'neutro_secondary','123','456',NOW(),5,NOW(),'all_contacts',NOW(),NOW()";
  assert.deepEqual((await db.query("EXECUTE generic_candidates("+args+")")).rows,[]);
  assert.deepEqual((await db.query("EXECUTE generic_recheck("+args+")")).rows,[]);
  const hint=(await db.query("EXECUTE generic_due('neutro_secondary','123','456',NOW(),NOW(),'all_contacts',NOW(),NOW())")).rows[0];
  assert.equal(hint.next_due_at,null);
  assert.equal(hint.has_overdue,false);
  // A full sender-bound, consented Meta-ad journey must actually produce
  // a generic template candidate. Compilation-only tests cannot detect an
  // accidentally unsatisfiable marketing rule.
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES('neutro_secondary','100000000011111','200000000011111','Test secondary','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
    "VALUES('whatsapp','60125111999',$1) RETURNING id",[sender])).rows[0].id;
  const conversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
    "VALUES($1,'60125111999',$2,'bound') RETURNING id",
    [sender,contact])).rows[0].id;
  const ad=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','Hi, I am interested in Neutro Sense','wamid.generic-ad',"+
    "NOW()-INTERVAL '49 hours',NOW()-INTERVAL '49 hours') RETURNING id",
    [contact])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [ad,conversation]);
  await db.query(
    "INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,meta_ad_id,source_type) VALUES($1,$2,'test-ad-901','ad')",
    [ad,contact]);
  const lead=(await db.query(
    "INSERT INTO leads(contact_id,marketing_consent) VALUES($1,'opted_in') RETURNING id",
    [contact])).rows[0].id;
  const affirmation="I agree to receive WhatsApp follow-ups and related offers about TCM care from Neutro Sense TCM";
  const consent=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user',$2,'wamid.generic-consent',"+
    "NOW()-INTERVAL '28 hours',NOW()-INTERVAL '28 hours') "+
    "RETURNING id,source_created_at",
    [contact,affirmation])).rows[0];
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [consent.id,conversation]);
  await db.query(
    "UPDATE contacts SET whatsapp_opt_in_at=$2,whatsapp_opt_in_source='explicit_customer_message' WHERE id=$1",
    [contact,consent.source_created_at]);
  await db.query(
    "INSERT INTO whatsapp_marketing_consent_events"+
    "(contact_id,lead_id,source,message_id,provider_message_id,message_text,business_name,"+
    "consent_scope,consent_category,consented_at,consent_method,consent_service) "+
    "VALUES($1,$2,'explicit_customer_message',$3,'wamid.generic-consent',$4,'Neutro Sense TCM Centre',"+
    "'general_clinic_followups_and_related_offers','MARKETING',$5,'customer_whatsapp_text','neutro_general_tcm_care')",
    [contact,lead,consent.id,affirmation,consent.source_created_at]);
  await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_rules"+
    "(sender_id,slot_hours,enabled,template_name,language_code,template_signature,operator_billing_approved) "+
    "VALUES($1,48,TRUE,'old_treatment_template','en_US',$2,TRUE)",
    [sender,"a".repeat(64)]);
  const activation=new Date(Date.now()-6*86400000).toISOString();
  const p=["neutro_secondary","100000000011111","200000000011111",
    new Date(),5,activation,"ads_only",activation,activation];
  const eligible=(await db.query(general.CANDIDATES_SQL,p)).rows;
  assert.equal(eligible.length,1,"signed Meta ad + fresh generic consent selects exactly one template");
  assert.equal(eligible[0].template_name,"ns_general_48h_optin_v1");
  assert.equal(eligible[0].language_code,"en_US");
  assert.equal(Number(eligible[0].inbound_id),Number(ad));
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,0,
    "a template without an atomic one-shot claim cannot send");
  const attempt=(await db.query(
    "INSERT INTO whatsapp_sender_marketing_followup_attempts"+
    "(sender_id,contact_id,anchor_message_id,slot_hours,status) "+
    "VALUES($1,$2,$3,48,'claimed') RETURNING id",
    [sender,contact,ad])).rows[0].id;
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,1,
    "claimed generic marketing follow-up survives independent final consent check");
  await db.query("UPDATE contacts SET whatsapp_marketing_opt_out_at=NOW() WHERE id=$1",[contact]);
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,0,
    "fresh marketing opt-out cancels the claimed generic send");
  await db.query("UPDATE contacts SET whatsapp_marketing_opt_out_at=NULL WHERE id=$1",[contact]);
  await db.query("UPDATE contacts SET mode='staff' WHERE id=$1",[contact]);
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,0,
    "manual Staff mode cancels the generic send");
  await db.query("DELETE FROM whatsapp_sender_marketing_followup_attempts WHERE id=$1",[attempt]);
  await db.query("DEALLOCATE ALL");
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
