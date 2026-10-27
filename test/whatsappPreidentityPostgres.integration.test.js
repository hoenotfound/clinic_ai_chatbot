"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const {acceptPreidentityBatch}=require("../src/services/pr395PreidentityReceiver");

const url=process.env.TEST_DATABASE_URL;
test("Postgres v102 durably audits only pinned preidentity account_update without customer content",{
 skip:!url
},async()=>{
 const db=new Client({connectionString:url});
 const schema="pr395_preidentity_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const database={
   query:(...args)=>db.query(...args),
   connect:async()=>{
    const c=new Client({connectionString:url});
    await c.connect();
    await c.query("SET search_path TO "+schema);
    return{query:(...args)=>c.query(...args),release:()=>c.end()};
   }
  };
  assert.equal(loadMigrations().at(-1).version,104);
  await runMigrations(database,{quiet:true});
  const env={
   PR395_STAGING_MODE:"true",
   PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED:"true",
   PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"false",
   PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false",
   WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
   WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60120000000",
   PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60120000000",
   WHATSAPP_PHONE_NUMBER:"+60129998888",
   WHATSAPP_WABA_ID:"111111111111111",
   WHATSAPP_APP_SECRET:"synthetic-one-app-secret",
   META_APP_SECRET:"synthetic-one-app-secret"
  };
  const body={object:"whatsapp_business_account",entry:[{
   id:"333333333333333",time:1800000000,changes:[{
    field:"account_update",value:{
     event:"PARTNER_REMOVED",phone_number:"+60 12-000 0000",
     disconnection_info:{reason:"do-not-store-raw-confidential-event"}
    }
   }]
  }]};
  const first=await acceptPreidentityBatch(body,{database,env});
  assert.equal(first.inserted,1);
  const replay=await acceptPreidentityBatch(body,{database,env});
  assert.equal(replay.inserted,0);
  const rows=(await db.query(
   "SELECT candidate_waba_id,candidate_phone_e164,event_type,entry_time "+
   "FROM whatsapp_coexistence_preidentity_events"
  )).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].candidate_waba_id,"333333333333333");
  assert.equal(rows[0].candidate_phone_e164,"+60120000000");
  assert.equal(rows[0].event_type,"PARTNER_REMOVED");
  const details=(await db.query(
   "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 "+
   "AND table_name='whatsapp_coexistence_preidentity_events'",[schema]
  )).rows.map(x=>x.column_name);
  assert.equal(details.includes("payload"),false);
  assert.equal(details.includes("access_token"),false);
  assert.equal(details.includes("contact_phone"),false);
  const wrong={...body,entry:[{...body.entry[0],changes:[{
   field:"account_update",value:{event:"PARTNER_REMOVED",phone_number:"+60125555555"}
  }]}]};
  await assert.rejects(acceptPreidentityBatch(wrong,{database,env}));
  assert.equal((await db.query(
   "SELECT COUNT(*)::int AS n FROM whatsapp_coexistence_preidentity_events"
  )).rows[0].n,1);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM messages")).rows[0].n,0);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n,0);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
