"use strict";
// Full HTTP -> Meta raw-body HMAC -> real receiver -> PostgreSQL transaction.
// Uses a disposable local CI database, never Neon or customer information.
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {Client,Pool}=require("pg");
const {createApp}=require("../src/createApp");
const capture=require("../src/services/whatsappSecondaryQaCapture");
const readiness=require("../src/services/startupReadinessService");
const {execFileSync}=require("node:child_process");

const local=process.env.TEST_DATABASE_URL;
function assertLocal(){
  const url=new URL(local);
  if(!["localhost","127.0.0.1"].includes(url.hostname) ||
     !["postgres:","postgresql:"].includes(url.protocol))
    throw Error("Refusing signed HTTP test outside local PostgreSQL");
}
function env(){
  return {
    WHATSAPP_APP_SECRET:"synthetic-app-secret-".repeat(3),
    META_APP_SECRET:"synthetic-app-secret-".repeat(3),
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"synthetic-verify-token-".repeat(2),
    WHATSAPP_WABA_ID:"1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60174831336",
    // Special gated clinic rehearsal; IDs remain synthetic, never real Meta.
    WHATSAPP_PAID_REAL_CLINIC_REHEARSAL_ENABLED:"true",
    WHATSAPP_PAID_REAL_CLINIC_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_REAL_CLINIC_E164_PIN:"+60174831336",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
      "postgresql://qa:synthetic@ep-qa.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-qa.ap-southeast-1.aws.neon.tech",
    DATABASE_URL:"postgresql://prod:synthetic@ep-prod.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
    WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
    WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60174831336",
    WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:crypto.randomBytes(32).toString("base64")
  };
}
function payload(field,content="synthetic-text-only"){
  return JSON.stringify({object:"whatsapp_business_account",entry:[{
    id:"889900",time:1790000000,changes:[{field,value:{
      metadata:{phone_number_id:"112233"},
      events:[{id:"synthetic-"+field,text:content}]
    }}]
  }]});
}
function signed(secret,raw){
  return "sha256="+crypto.createHmac("sha256",secret).update(raw).digest("hex");
}
function setEnv(t,values){
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(values))process.env[k]=v;
  t.after(()=>{
    for(const [k,v] of Object.entries(previous)){
      if(v==null)delete process.env[k];else process.env[k]=v;
    }
    readiness.resetForTests();
  });
}
async function server(app,fn){
  const instance=await new Promise((resolve,reject)=>{
    const http=app.listen(0,"127.0.0.1",()=>resolve(http));
    http.on("error",reject);
  });
  try {return await fn("http://127.0.0.1:"+instance.address().port);}
  finally {await new Promise(resolve=>instance.close(resolve));}
}
test("signed real HTTP secondary capture persists, deduplicates, isolates and enforces history consent",{
  // Run only in a dedicated CI step after npm test to avoid competing
  // CREATE/DROP DATABASE operations with the v077->v079 rehearsal.
  skip:!local||process.env.RUN_SECONDARY_QA_HTTP_INTEGRATION!=="true",timeout:120000
},async t=>{
  assertLocal();
  const databaseName="qa_capture_http_"+crypto.randomBytes(6).toString("hex");
  const admin=new Client({connectionString:local});
  let created=false,pool;
  const e=env();
  setEnv(t,e);
  readiness.markReady();
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE "+databaseName);
    created=true;
    const url=new URL(local);url.pathname="/"+databaseName;
    pool=new Pool({connectionString:url.toString(),max:2});
    await pool.query("CREATE TABLE schema_migrations(version int PRIMARY KEY,name text NOT NULL)");
    await pool.query("INSERT INTO schema_migrations(version,name) VALUES " +
      "(102,'whatsapp_coexistence_preidentity_events')," +
      "(103,'whatsapp_legacy_lifecycle_relay_audit')," +
      "(104,'whatsapp_coexistence_once_only_and_lifecycle_alerts')");
    await pool.query("CREATE TABLE whatsapp_sender_accounts (" +
      "id BIGSERIAL PRIMARY KEY,sender_key text UNIQUE NOT NULL," +
      "meta_account_id text NOT NULL,meta_phone_number_id text NOT NULL," +
      "state text NOT NULL,coexistence_enabled boolean NOT NULL)");
    await pool.query("INSERT INTO whatsapp_sender_accounts " +
      "(sender_key,meta_account_id,meta_phone_number_id,state,coexistence_enabled) " +
      "VALUES('coexistence_qa','889900','112233','testing',TRUE)");
    await pool.query("CREATE TABLE whatsapp_secondary_qa_capture_events (" +
      "fingerprint text PRIMARY KEY,sender_id bigint NOT NULL " +
      "REFERENCES whatsapp_sender_accounts(id)," +
      "event_field text NOT NULL,ciphertext bytea NOT NULL," +
      "nonce bytea NOT NULL,auth_tag bytea NOT NULL,payload_bytes integer NOT NULL," +
      "expires_at timestamptz NOT NULL)");
    let primaryCalled=0;
    const app=createApp({
      sessionSecret:"isolated-real-db-integration-test".repeat(3),
      durablyClaimIncoming:async()=>{primaryCalled++;throw Error("Neutro must not be called");},
      scheduleDurableClaim:async()=>{},queueIncomingForReply:async()=>{},
      captureSecondaryQaBatch:(body,opts)=>
        capture.captureSignedSecondaryBatch(body,{...opts,env:e,database:pool})
    });
    await server(app,async base=>{
      async function post(raw,signature,fieldHeader){
        return fetch(base+"/whatsapp/secondary-qa-capture",{
          method:"POST",
          headers:{"Content-Type":"application/json",
            ...(signature?{"X-Hub-Signature-256":signature}:{}),
            ...(fieldHeader||{})},
          body:raw
        });
      }
      const message=payload("messages");
      assert.equal((await post(message,null)).status,403);
      assert.equal((await post(message,"sha256="+"0".repeat(64))).status,403);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM whatsapp_secondary_qa_capture_events")).rows[0].n,0);
      const valid=signed(e.WHATSAPP_APP_SECRET,message);
      const first=await post(message,valid);
      assert.equal(first.status,200);
      assert.deepEqual(await first.json(),{durable:true,accepted:1,inserted:1});
      const replay=await post(message,valid);
      assert.equal(replay.status,200);
      assert.equal((await replay.json()).inserted,0);
      for(const field of ["smb_message_echoes","history","smb_app_state_sync"]){
        const raw=payload(field);
        const response=await post(raw,signed(e.WHATSAPP_APP_SECRET,raw));
        assert.equal(response.status,200,field);
        assert.equal((await response.json()).inserted,1,field);
      }
      // Meta's APP-DEFAULT callback (not the dedicated synthetic endpoint)
      // must also be able to reach the exact pinned secondary QA capture.
      const throughDefault=payload("messages","synthetic-default-route");
      const defaultResponse=await fetch(base+"/whatsapp/default",{
        method:"POST",
        headers:{"Content-Type":"application/json",
          "X-Hub-Signature-256":signed(e.WHATSAPP_APP_SECRET,throughDefault)},
        body:throughDefault
      });
      assert.equal(defaultResponse.status,200);
      const defaultReplay=await fetch(base+"/whatsapp/default",{
        method:"POST",
        headers:{"Content-Type":"application/json",
          "X-Hub-Signature-256":signed(e.WHATSAPP_APP_SECRET,throughDefault)},
        body:throughDefault
      });
      assert.equal(defaultReplay.status,200);
      const entries=(await pool.query(
        "SELECT event_field,fingerprint,ciphertext,nonce,auth_tag,payload_bytes " +
        "FROM whatsapp_secondary_qa_capture_events ORDER BY event_field")).rows;
      assert.equal(entries.length,5);
      for(const entry of entries){
        const decipher=crypto.createDecipheriv("aes-256-gcm",
          Buffer.from(e.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64,"base64"),entry.nonce);
        decipher.setAAD(Buffer.from(entry.fingerprint,"ascii"));
        decipher.setAuthTag(entry.auth_tag);
        const plain=Buffer.concat([decipher.update(entry.ciphertext),decipher.final()]);
        assert.equal(plain.length,entry.payload_bytes);
        assert.match(plain.toString("utf8"),/synthetic-text-only|synthetic-default-route/);
        assert.doesNotMatch(entry.ciphertext.toString("utf8"),/synthetic-text-only/);
      }
      const foreign=JSON.parse(message);foreign.entry[0].id="777123";
      const foreignRaw=JSON.stringify(foreign);
      assert.equal((await post(foreignRaw,signed(e.WHATSAPP_APP_SECRET,foreignRaw))).status,503);
      const history=payload("history","consent-required");
      e.WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED="false";
      assert.equal((await post(history,signed(e.WHATSAPP_APP_SECRET,history))).status,503);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM whatsapp_secondary_qa_capture_events")).rows[0].n,5);
      assert.equal(primaryCalled,0);
    });
  } finally {
    if(pool)await pool.end().catch(()=>{});
    if(created)await admin.query("DROP DATABASE "+databaseName+" WITH (FORCE)");
    await admin.end();
  }
});
