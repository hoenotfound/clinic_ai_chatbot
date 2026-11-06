"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { runMigrations } = require("../src/db/migrationRunner");
const { recoverUnavailableFirstTouchAd } = require("../src/db/leadAttributionRepo");

const cs = process.env.TEST_DATABASE_URL;
const ad={
  source:"meta_ads",channel:"whatsapp",platform:"meta",adId:"120246874060960540",
  sourceType:"ad",sourceId:"120246874060960540",adName:"Pelvic Alignment",
};

test("Postgres repairs only a verified immediate secondary 131060/ad pair, once",{
  skip:!cs,
},async(t)=>{
  const schema="unavailable_meta_ad_"+process.pid+"_"+Date.now();
  const db=new Client({connectionString:cs});
  await db.connect();
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  t.after(async()=>{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end().catch(()=>{});
  });
  const migrator={async connect(){
    const client=new Client({connectionString:cs});
    await client.connect();
    await client.query("SET search_path TO "+schema);
    return {query:(...args)=>client.query(...args),release:()=>client.end()};
  }};
  await runMigrations(migrator,{quiet:true});
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES('neutro_secondary','1318355951360575','1852014482431209','Secondary','active') RETURNING id"
  )).rows[0].id;
  const stage=(await db.query(
    "SELECT id FROM pipeline_stages WHERE system_key='new' LIMIT 1"
  )).rows[0].id;
  const start=new Date(Date.now()-120000);
  let serial=0;
  async function fixture({code=131060,withIntervening=false,source="whatsapp_unattributed",
    offsetMs=3000}={}) {
    serial++;
    const phone="601455"+String(serial).padStart(6,"0");
    const contact=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
      "VALUES('whatsapp',$1,$2) RETURNING id",[phone,sender])).rows[0].id;
    const conversation=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
      "VALUES($1,$2,$3,'bound') RETURNING id",
      [sender,contact,phone])).rows[0].id;
    async function message(content,ms,payload){
      serial++;
      const when=new Date(start.getTime()+ms);
      const id=(await db.query(
        "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
        "VALUES($1,'user',$2,$3,$4,$4) RETURNING id",
        [contact,content,"wamid.test-131060-"+serial,when])).rows[0].id;
      await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [id,conversation]);
      if(payload)await db.query(
        "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) "+
        "VALUES($1,$2,'whatsapp',$3::jsonb,'completed')",
        [id,contact,JSON.stringify(payload)]);
      return id;
    }
    const initial=await message("📎 [Customer sent a WhatsApp message that could not be displayed]",
      serial*10,{unsupportedType:"unsupported",text:null,unsupportedErrors:[{code}]});
    if(withIntervening) await message("Another customer message",serial*10+1000,{text:"other"});
    const verified=await message("Hi, pelvic treatment",serial*10+offsetMs,{
      text:"Hi, pelvic treatment",attribution:{source:"meta_ads",sourceType:"ad",adId:ad.adId},
    });
    const lead=(await db.query(
      "INSERT INTO leads(contact_id,stage_id,started_message_id,created_by,source) "+
      "VALUES($1,$2,$3,'Automation',$4) RETURNING id",
      [contact,stage,initial,source])).rows[0].id;
    await db.query(
      "INSERT INTO lead_attributions(lead_id,first_message_id,source,platform,channel) "+
      "VALUES($1,$2,$3,'whatsapp','whatsapp')",
      [lead,initial,source]);
    return {lead,initial,verified,contact};
  }
  const adapter={async connect(){return {query:(...args)=>db.query(...args),release(){}};}};
  const f=await fixture();
  const got=await recoverUnavailableFirstTouchAd({
    leadId:f.lead,inboundMessageId:f.verified,attribution:ad,
  },adapter);
  assert.ok(got,"original 131060 plus verified follow-up ad must be repaired");
  assert.equal(got.first_message_id,f.verified);
  assert.equal(got.source,"meta_ads");
  assert.equal(got.meta_ad_id,ad.adId);
  assert.equal(got.enrichment_status,"pending");
  const lead=(await db.query("SELECT source FROM leads WHERE id=$1",[f.lead])).rows[0];
  assert.equal(lead.source,"meta_ads");
  assert.equal(await recoverUnavailableFirstTouchAd({
    leadId:f.lead,inboundMessageId:f.verified,attribution:ad,
  },adapter),null,"repeat webhook cannot rewrite attribution");
  const activity=(await db.query(
    "SELECT COUNT(*)::int AS n FROM lead_activities WHERE lead_id=$1 AND activity_type='attribution'",
    [f.lead])).rows[0].n;
  assert.equal(activity,1,"repair must log exactly one audit event");

  const wrongCode=await fixture({code:131051});
  assert.equal(await recoverUnavailableFirstTouchAd({
    leadId:wrongCode.lead,inboundMessageId:wrongCode.verified,attribution:ad,
  },adapter),null,"a different unavailable payload must not be reattributed");

  const intervening=await fixture({withIntervening:true});
  assert.equal(await recoverUnavailableFirstTouchAd({
    leadId:intervening.lead,inboundMessageId:intervening.verified,attribution:ad,
  },adapter),null,"a substantive intervening turn must preserve true first touch");

  const late=await fixture({offsetMs:2*60*1000+1000});
  assert.equal(await recoverUnavailableFirstTouchAd({
    leadId:late.lead,inboundMessageId:late.verified,attribution:ad,
  },adapter),null,"a later ad is not the original first touch");

  const mismatch=await fixture();
  assert.equal(await recoverUnavailableFirstTouchAd({
    leadId:mismatch.lead,inboundMessageId:mismatch.verified,
    attribution:{...ad,adId:"wrong-ad"},
  },adapter),null,"database Meta referral proof must match the proposed ad");

  for(const ignored of [wrongCode,intervening,late,mismatch]){
    const row=(await db.query(
      "SELECT source,first_message_id FROM lead_attributions WHERE lead_id=$1",
      [ignored.lead])).rows[0];
    assert.equal(row.source,"whatsapp_unattributed");
    assert.equal(row.first_message_id,ignored.initial);
  }
});
