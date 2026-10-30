"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations,loadMigrations}=require("../src/db/migrationRunner");
const {recordBatch}=require("../src/services/pr395LegacyLifecycleReceiver");
const url=process.env.TEST_DATABASE_URL;
test("PostgreSQL 105 accepts signed legacy lifecycle metadata only, idempotently and without touching Neutro data",{
 skip:!url
},async()=>{
 const root=new Client({connectionString:url});
 const schema="pr395_legacyaudit_"+process.pid+"_"+Date.now();
 await root.connect();
 try{
  await root.query("CREATE SCHEMA "+schema);
  await root.query("SET search_path TO "+schema);
  const database={
   query:(...args)=>root.query(...args),
   connect:async()=>{
    const c=new Client({connectionString:url});
    await c.connect();await c.query("SET search_path TO "+schema);
    return{query:(...args)=>c.query(...args),release:()=>c.end()};
   }
  };
  assert.equal(loadMigrations().at(-1).version,109);
  await runMigrations(database,{quiet:true});
  const env={
   PR395_STAGING_MODE:"true",
   PR395_STAGING_LEGACY_LIFECYCLE_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
   PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60120000000",
   PR395_STAGING_LEGACY_WABA_ID:"1593376338308612",
   PR395_STAGING_LEGACY_PHONE_E164:"+601130535053",
   WHATSAPP_APP_SECRET:"test-only-legacy-meta-app-secret",
   META_APP_SECRET:"test-only-legacy-meta-app-secret"
  };
  const input={object:"whatsapp_business_account",entry:[{
   id:"1593376338308612",time:1800000000,changes:[{
    field:"account_update",value:{event:"PARTNER_REMOVED",
      phone_number:"+60 11-3053 5053",
      disconnection_info:{reason:"do-not-store-sensitive-provider-metadata"}}
   }]
  }]};
  const a=await recordBatch(input,{database,env});
  const b=await recordBatch(input,{database,env});
  assert.deepEqual([a.inserted,b.inserted],[1,0]);
  const rows=(await root.query(
   "SELECT account_id,event_type,account_phone_e164,handling_status "+
   "FROM whatsapp_legacy_lifecycle_relay_audit"
  )).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].account_id,env.PR395_STAGING_LEGACY_WABA_ID);
  assert.equal(rows[0].event_type,"PARTNER_REMOVED");
  assert.equal(rows[0].handling_status,"review_required");
  const columns=(await root.query(
   "SELECT column_name FROM information_schema.columns "+
   "WHERE table_schema=$1 AND table_name='whatsapp_legacy_lifecycle_relay_audit'",
   [schema]
  )).rows.map(x=>x.column_name);
  for(const forbidden of ["payload","raw","access_token","contact_id","customer_text"])
   assert.equal(columns.includes(forbidden),false);
  const wrong={...input,entry:[{...input.entry[0],id:"777777777777777"}]};
  await assert.rejects(recordBatch(wrong,{database,env}),/mismatch/);
  assert.equal((await root.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n,0);
  assert.equal((await root.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_accounts")).rows[0].n,0);
 }finally{
  await root.query("SET search_path TO public").catch(()=>{});
  await root.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await root.end();
 }
});
