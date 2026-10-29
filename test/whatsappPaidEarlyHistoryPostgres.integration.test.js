"use strict";
// Disposable, LOCAL PostgreSQL only. Never touches Neutro's Neon database.
const test=require("node:test"),assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const hold=require("../src/services/whatsappPaidEarlyHistoryCapture");
const {recordValidatedWithCredential}=require("../src/db/whatsappCoexistenceOnboardingRepo");
const secret="test-only-meta-hmac-key-not-a-live-secret";
const waba="222222222222222",phone="333333333333333";
const pre={
 PR395_STAGING_MODE:"false",
 WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
 WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OWNER_CONSENT_VERIFIED:"true",
 WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED:"true",
 WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED:"true",
 WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,25).toString("base64"),
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
 WHATSAPP_WABA_ID:"1593376338308612",WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_PHONE_NUMBER:"+601130535053",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL:new Date(Date.now()+3600000).toISOString()
};
const verified={
 ...pre,WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"false",
 WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_HANDOFF_OPERATOR_APPROVED:"true",
 WHATSAPP_SECONDARY_WABA_ID:waba,WHATSAPP_SECONDARY_PHONE_NUMBER_ID:phone,
 WHATSAPP_SECONDARY_EXPECTED_WABA_ID:waba,
 WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:phone,
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true"
};
const packet={object:"whatsapp_business_account",entry:[{
 id:waba,changes:[{field:"history",value:{
  metadata:{phone_number_id:phone,display_phone_number:"+60 17-483 1336"},
  history:[{threads:[{id:"60123234455",messages:[{
   id:"wamid.synthetic-early-001",from:"60123234455",type:"text",
   timestamp:String(Math.floor(Date.now()/1000)-3600),
   text:{body:"synthetic example, not customer data"}
  }]}]}]
 }}]
}]};
test("disposable PostgreSQL: unverified encrypted hold, verified durable handoff and clean primary",{
 skip:!process.env.TEST_DATABASE_URL,timeout:120000
},async()=>{
 const url=process.env.TEST_DATABASE_URL;
 if(!["localhost","127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Refusing nonlocal integration database");
 const client=new Client({connectionString:url});
 const schema="early_hold_"+process.pid+"_"+Date.now();
 await client.connect();
 try{
  await client.query("CREATE SCHEMA "+schema);
  await client.query("SET search_path TO "+schema);
  const db={
   query:(...args)=>client.query(...args),
   connect:async()=>{
    const c=new Client({connectionString:url});
    await c.connect();await c.query("SET search_path TO "+schema);
    return {query:(...args)=>c.query(...args),release:()=>c.end()};
   }
  };
  await runMigrations(db,{quiet:true});
  await client.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_account_id,meta_phone_number_id,display_name,state,coexistence_enabled) VALUES('neutro',$1,$2,'Primary','active',FALSE)",
   [pre.WHATSAPP_WABA_ID,pre.WHATSAPP_PHONE_NUMBER_ID]);
  await hold.stage(packet,{env:pre,database:db});
  await hold.stage(packet,{env:pre,database:db});
  const holds=(await client.query(
   "SELECT event_field,ciphertext FROM whatsapp_secondary_early_history_hold")).rows;
  assert.equal(holds.length,1);
  assert.equal(holds[0].ciphertext.includes(Buffer.from("synthetic example")),false);
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs")).rows[0].n,0);
  await assert.rejects(()=>hold.handoffOnce({env:verified,database:db}),/not verified/);
  await recordValidatedWithCredential({
   wabaId:waba,phoneNumberId:phone,displayPhoneNumber:"+60 17-483 1336",
   coexistenceReady:true,tokenExpiresAt:new Date(Date.now()+86400000).toISOString(),
   accessToken:"synthetic-authorized-token-for-local-test-only"
  },{env:verified,database:db});
  await client.query(
   "INSERT INTO whatsapp_sender_accounts(sender_key,meta_account_id,meta_phone_number_id,display_name,state,coexistence_enabled) VALUES('neutro_secondary',$1,$2,'Secondary','active',TRUE)",
   [waba,phone]);
  await assert.rejects(()=>hold.handoffOnce({env:verified,database:db,
   stageHistory:async()=>{throw Error("synthetic target failure")}
  }),/synthetic target failure/);
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_secondary_early_history_hold")).rows[0].n,1);
  const outcome=await hold.handoffOnce({env:verified,database:db,maxEvents:5});
  assert.equal(outcome.transferred,1);
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_secondary_early_history_hold")).rows[0].n,0);
  assert.deepEqual((await client.query(
   "SELECT s.sender_key FROM whatsapp_sender_coexistence_import_jobs j JOIN whatsapp_sender_accounts s ON s.id=j.sender_id")).rows,
   [{sender_key:"neutro_secondary"}]);
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n,0);
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM messages")).rows[0].n,0);
  assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_attempts")).rows[0].n,0);
  assert.equal((await client.query("SELECT state FROM whatsapp_sender_accounts WHERE sender_key='neutro'")).rows[0].state,"active");
 }finally{
  await client.query("SET search_path TO public").catch(()=>{});
  await client.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await client.end();
 }
});
