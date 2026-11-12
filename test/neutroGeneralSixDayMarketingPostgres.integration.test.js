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
  assert.ok(expected.body.includes("Neutro Sense TCM") || /您好|中医|中醫|Hai/.test(expected.body));
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
 assert.match(general.CANDIDATES_SQL,/status='claimed'/);
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
  await db.query("PREPARE generic_candidates(text,text,text,timestamptz,integer,timestamptz,text,timestamptz,timestamptz) AS "+general.CANDIDATES_SQL);
  await db.query("PREPARE generic_recheck(text,text,text,timestamptz,integer,timestamptz,text,timestamptz,timestamptz) AS "+general.RECHECK_SQL);
  await db.query("PREPARE generic_due(text,text,text,timestamptz,timestamptz,text,timestamptz,timestamptz) AS "+general.POTENTIAL_DUE_SQL);
  await db.query("PREPARE generic_consent(integer,integer,timestamptz) AS "+secondaryPolicy.SECONDARY_GENERIC_MARKETING_CONSENT_SQL);
  const args="'neutro_secondary','123','456',NOW(),5,NOW(),'all_contacts',NOW(),NOW()";
  assert.deepEqual((await db.query("EXECUTE generic_candidates("+args+")")).rows,[]);
  assert.deepEqual((await db.query("EXECUTE generic_recheck("+args+")")).rows,[]);
  const hint=(await db.query("EXECUTE generic_due('neutro_secondary','123','456',NOW(),NOW(),'all_contacts',NOW(),NOW())")).rows[0];
  assert.equal(hint.next_due_at,null);
  assert.equal(hint.has_overdue,false);
  await db.query("DEALLOCATE ALL");
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
