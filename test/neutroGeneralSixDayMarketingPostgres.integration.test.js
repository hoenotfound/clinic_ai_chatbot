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
  // Candidate simulation follows the same allowed sending hours as the
  // production scheduler, irrespective of the time the CI job starts.
  const candidateAt=new Date();
  const candidateMinute=(candidateAt.getUTCHours()*60+
    candidateAt.getUTCMinutes()+480)%1440;
  if(candidateMinute<7*60){
    candidateAt.setTime(candidateAt.getTime()+
      (7*60-candidateMinute)*60000-candidateAt.getUTCSeconds()*1000-
      candidateAt.getUTCMilliseconds());
  }
  const p=["neutro_secondary","100000000011111","200000000011111",
    candidateAt,5,activation,"ads_only",activation,activation];
  const bareWhere=general.CANDIDATES_SQL.indexOf("\n WHERE rule.enabled=TRUE");
  const order=general.CANDIDATES_SQL.lastIndexOf("\n ORDER BY inbound.created_at");
  assert.ok(bareWhere>0&&order>bareWhere);
  const candidateFrom=general.CANDIDATES_SQL.slice(0,bareWhere);
  const withoutSafeguards=candidateFrom+
    "\n WHERE rule.enabled=TRUE AND rule.operator_billing_approved=TRUE"+
    " AND rule.slot_hours IN(48,66,96,144)"+
    " AND $6::timestamptz IS NOT NULL AND $7::text IS NOT NULL AND $8::timestamptz IS NOT NULL"+
    general.CANDIDATES_SQL.slice(order);
  const joined=(await db.query(withoutSafeguards,p)).rows;
  if(joined.length===0){
    const fromNoConsent=candidateFrom.replace(/\n JOIN LATERAL \(\n   SELECT e\.id,e\.consented_at,[\s\S]*?\n \) general_consent ON TRUE/,"");
    console.error("No matched generic campaign from core consent join",{
      hasConsentNode:fromNoConsent!==candidateFrom});
  }
  assert.ok(joined.length>0,"signed ad and valid consent must survive core sender, lead and opt-in joins");
  const eligible=(await db.query(general.CANDIDATES_SQL,p)).rows;
  if(!eligible.length){
    const parts=["   AND @@AUDIENCE@@","   AND @@REVIEWED@@",
      "   AND @@APPOINTMENT@@","   AND @@CANCELLATION@@",
      "   AND NOT @@TEMPORARY_STAFF@@","   AND NOT @@RECENT_STAFF@@",
      "   AND NOT @@PENDING_STAFF@@","   AND @@ATTENTION@@"];
    const full=general.CANDIDATES_SQL.slice(bareWhere,order);
    const conditions=full.split("\n   AND ").map(x=>x.trim());
    console.error("Generic joined but no candidate",{
      rows:joined.map(x=>({inbound:x.inbound_id,consent:x.consent_id,
        locale:x.language_code,slot:x.slot_hours})),
      predicateCount:conditions.length});
    for(const token of [
      "   AND c.mode='ai'",
      "   AND c.whatsapp_opt_in_at IS NOT NULL",
      "   AND lead.marketing_consent='opted_in'",
      "   AND $4::timestamptz<inbound.created_at+INTERVAL '167 hours'",
      "   AND inbound.created_at+rule.slot_hours*INTERVAL '1 hour'<=$4::timestamptz",
      "   AND inbound.created_at+rule.slot_hours*INTERVAL '1 hour'> $4::timestamptz-INTERVAL '8 hours'",
    ]){
      const test=general.CANDIDATES_SQL.replace(token," AND FALSE");
      if(test===general.CANDIDATES_SQL)console.error("missing token",token);
    }
  }
  // Active customers must not receive a paid reminder moments after asking
  // a new question. The same selector is used for final send rechecks.
  const active=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','Can I ask about the assessment?','wamid.generic-active',"+
    "NOW()-INTERVAL '2 minutes',NOW()-INTERVAL '2 minutes') RETURNING id",
    [contact])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [active,conversation]);
  assert.equal((await db.query(general.CANDIDATES_SQL,p)).rows.length,0,
    "a newly active customer holds the 48h generic template");
  // Unlike the previous fixed eight-hour cutoff, a fresh customer reply
  // shifts the due time rather than silently losing the whole sequence.
  const nextDay=[...p];
  // The real scheduler suppresses marketing sends during Malaysia quiet hours.
  // Keep the resumption test >=25h after fresh activity, at an allowed hour.
  const resumedAt=new Date(Date.now()+25*3600000);
  const localMinute=(resumedAt.getUTCHours()*60+resumedAt.getUTCMinutes()+480)%1440;
  if(localMinute<7*60){
    resumedAt.setTime(resumedAt.getTime()+
      (7*60-localMinute)*60000-resumedAt.getUTCSeconds()*1000-
      resumedAt.getUTCMilliseconds());
  }
  nextDay[3]=resumedAt;
  const resumed=(await db.query(general.CANDIDATES_SQL,nextDay)).rows;
  assert.equal(resumed.length,1,
    "a postponed 48h stage becomes eligible after 24 hours of inactivity");
  assert.equal(resumed[0].slot_hours,48);
  await db.query("DELETE FROM whatsapp_sender_message_context WHERE message_id=$1",[active]);
  await db.query("DELETE FROM messages WHERE id=$1",[active]);
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
  // RECHECK_SQL uses the same explicit $4 clock as the candidate query,
  // so both should agree at the simulated permitted sending time.
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,1,
    "claimed generic marketing follow-up preserves sender and consent checks");
  // A reply arriving between the one-shot claim and the provider call must
  // also cancel the template during the final sender-bound recheck.
  const justReplied=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','One more question','wamid.generic-recheck-activity',"+
    "NOW()-INTERVAL '1 minute',NOW()-INTERVAL '1 minute') RETURNING id",
    [contact])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [justReplied,conversation]);
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,0,
    "new customer question prevents send after the claim");
  await db.query("DELETE FROM whatsapp_sender_message_context WHERE message_id=$1",[justReplied]);
  await db.query("DELETE FROM messages WHERE id=$1",[justReplied]);
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,1,
    "ordinary eligibility returns after the active-message fixture is removed");
  await db.query("UPDATE contacts SET whatsapp_marketing_opt_out_at=NOW() WHERE id=$1",[contact]);
  assert.equal((await db.query(general.RECHECK_SQL,p)).rows.length,0,
    "fresh marketing opt-out cancels the claimed generic send");
  await db.query("UPDATE contacts SET whatsapp_marketing_opt_out_at=NULL WHERE id=$1",[contact]);
  await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[contact]);
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
