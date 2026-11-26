"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const config=require("../src/config/clinicConfig");
const defaults=require("../src/config/neutroRm68Campaign.default.json");
const {rm68CampaignSettings,validRm68CampaignSettings}=require("../src/config/neutroRm68CampaignConfig");
const {PREFILL,campaignDay,firstReply,campaignFollowUp,hasCampaignConversation,configuredFirstReplyImage}=require("../src/utils/neutroBreastRm68Campaign");
const clone=()=>JSON.parse(JSON.stringify(defaults));
const early=Date.parse("2026-11-26T00:00:00Z");
const last=Date.parse(defaults.lastDayStartsAt);
const end=Date.parse(defaults.expiresAt);
const sql=fs.readFileSync(path.join(__dirname,"../src/db/migrations/139_neutro_rm68_campaign_config.sql"),"utf8");
test("Neon seed matches the exact backward-compatible approved campaign",()=>{
  assert.deepEqual(JSON.parse(sql.split("$rm68_config$")[1]),defaults);
  assert.equal(validRm68CampaignSettings(defaults),true);
  assert.equal(rm68CampaignSettings({}).source,"legacy_default");
  assert.equal(rm68CampaignSettings({neutroRm68Campaign:clone()}).source,"neon");
});
test("runtime loads stored welcome and follow-up copy, stops at configured expiry and preserves historical recognition",()=>{
  const previous=config.neutroRm68Campaign;
  const had=Object.hasOwn(config,"neutroRm68Campaign");
  try{
    const stored=clone();
    stored.firstReply.both.zh+="\n谢谢您 😊";
    stored.followUp.both.zh+="\n谢谢您 😊";
    config.neutroRm68Campaign=stored;
    assert.equal(validRm68CampaignSettings(stored),true);
    assert.equal(firstReply(early),stored.firstReply.both.zh);
    assert.equal(firstReply(last,"ms"),stored.firstReply.dec6.ms);
    assert.equal(firstReply(end,"en"),stored.firstReply.expired.en);
    const candidate={channel:"whatsapp",trigger_message_content:defaults.firstReply.both.zh,
      recent_inbound_messages:[PREFILL],recent_service_messages:[PREFILL],
      ad_followup_source:"meta_ads",ad_followup_headline:"胸部专业检查 RM68体验优惠"};
    assert.equal(hasCampaignConversation([{role:"user",content:PREFILL},{role:"assistant",content:defaults.firstReply.both.zh}]),true);
    assert.equal(campaignFollowUp({candidate,now:early}).message,stored.followUp.both.zh);
    config.neutroRm68Campaign={...stored,expiresAt:"2026-12-05T00:00:00Z"};
    assert.equal(campaignDay(last),"expired");
    assert.deepEqual(campaignFollowUp({candidate,now:last}),{expired:true,message:null});
    config.neutroRm68Campaign={...stored,priceMYR:388};
    assert.equal(campaignDay(early),"expired");
    assert.doesNotMatch(firstReply(early),/RM\s*68/);
    assert.equal(configuredFirstReplyImage({config:{adFirstReply:{rm68ImageUrl:"/promo-images/41"}},businessName:"Neutro Sense TCM",now:early}),null);
  }finally{
    if(had)config.neutroRm68Campaign=previous;
    else delete config.neutroRm68Campaign;
  }
});
test("reject invalid event identity, expanded date range, changed amounts and missing delivery markers",()=>{
  for(const mutate of [
    c=>{c.eventDates=["2026-12-06","2026-12-07"];},
    c=>{c.expiresAt="2026-12-07T16:00:00Z";},
    c=>{c.firstReply.both.en=c.firstReply.both.en.replace("RM68","RM388");},
    c=>{c.followUp.dec6.ms=c.followUp.dec6.ms.replace("6 Disember","5 Disember");},
    c=>{c.firstReply.both.zh=c.firstReply.both.zh.replace("首次体验只需 RM68","体验 RM68");},
    c=>{c.followUp.both.en+=" Your appointment is confirmed.";},
  ]){
    const value=clone();mutate(value);
    assert.equal(validRm68CampaignSettings(value),false);
    assert.equal(rm68CampaignSettings({neutroRm68Campaign:value}).valid,false);
  }
});
test("migration only seeds Neutro, preserves other clinic settings and existing campaign",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const {Client}=require("pg");
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  const schema="rm68_config_"+process.pid+"_"+Date.now();
  await db.connect();
  try{
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    await db.query("CREATE TABLE clinic_config(id integer primary key,data jsonb not null,updated_at timestamptz default now())");
    const original={businessName:"Neutro Sense TCM Centre",businessType:"tcm_clinic",promotions:[{name:"unrelated offer"}]};
    const get=async()=>(await db.query("SELECT data FROM clinic_config WHERE id=1")).rows[0].data;
    await db.query("INSERT INTO clinic_config(id,data) VALUES(1,$1)",[{...original,businessName:"Other Clinic"}]);
    await db.query(sql);assert.equal((await get()).neutroRm68Campaign,undefined);
    await db.query("UPDATE clinic_config SET data=$1",[original]);
    await db.query(sql);assert.deepEqual(await get(),{...original,neutroRm68Campaign:defaults});
    const existing={...defaults,expiresAt:"2026-12-05T00:00:00Z"};
    await db.query("UPDATE clinic_config SET data=$1",[{...original,neutroRm68Campaign:existing}]);
    await db.query(sql);assert.deepEqual(await get(),{...original,neutroRm68Campaign:existing});
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});

test("early campaign expiry never claims the scheduled final day has already passed",()=>{
  const {campaignContextReply}=require("../src/utils/neutroBreastRm68Campaign");
  const old=config.neutroRm68Campaign,had=Object.hasOwn(config,"neutroRm68Campaign");
  try{
    const history=[{role:"user",content:PREFILL},{role:"assistant",content:firstReply(early)}];
    config.neutroRm68Campaign={...clone(),expiresAt:"2026-12-03T00:00:00Z"};
    const now=Date.parse("2026-12-04T00:00:00Z");
    assert.equal(campaignDay(now),"expired");
    for(const language of ["zh","en","ms"]){
      const reply=campaignContextReply({history,customerText:"RM68 还有吗？",now,language});
      assert.ok(reply);
      assert.doesNotMatch(reply,/12月6日|6 December|6 Disember|RM68/iu);
      assert.doesNotMatch(firstReply(now,language),/12月6日|6 December|6 Disember|RM68/iu);
    }
  }finally{if(had)config.neutroRm68Campaign=old;else delete config.neutroRm68Campaign;}
});
