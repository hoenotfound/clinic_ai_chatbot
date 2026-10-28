"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const capture = require("../src/services/whatsappSecondaryQaCapture");

function env(patch={}) {
  return {
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
    WHATSAPP_APP_SECRET:"A".repeat(32), META_APP_SECRET:"A".repeat(32),
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"T".repeat(32),
    WHATSAPP_WABA_ID:"1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60123334444",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:"postgresql://qa:secret@ep-qa.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-qa.ap-southeast-1.aws.neon.tech",
    DATABASE_URL:"postgresql://prod:secret@ep-prod.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
    WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
    WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60123334444",
    WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:Buffer.alloc(32,15).toString("base64"),
    ...patch
  };
}
function item(field="messages",account="889900",phone="112233",value={}) {
  return { object:"whatsapp_business_account",entry:[{
    id:account,time:1790000000,changes:[{
      field,value:{metadata:{phone_number_id:phone},...value}
    }]
  }]};
}
function db(opts={}) {
  const queries=[];
  let releases=0;
  return {
    queries, get releases(){return releases;},
    async connect(){return {
      async query(sql,args){
        queries.push({sql,args});
        if(opts.fail && sql.includes("INSERT INTO whatsapp_secondary_qa_capture_events")){
          throw Error("QA query failure");
        }
        if(sql.includes("FROM schema_migrations")){
          return {rows:[{version:102,name:"whatsapp_coexistence_preidentity_events"},
            {version:103,name:"whatsapp_legacy_lifecycle_relay_audit"},
            {version:104,name:"whatsapp_coexistence_once_only_and_lifecycle_alerts"}]};
        }
        if(sql.includes("FROM whatsapp_sender_accounts")){
          return {rows:opts.unbound?[]:[{id:900}]};
        }
        return {rowCount:opts.duplicate?0:1};
      },
      release(){releases++;}
    };}
  };
}
test("secondary staging remains default OFF and has no route connected to Neutro",()=>{
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"false"})),/disabled/);
  const app=fs.readFileSync(path.join(__dirname,"../src/createApp.js"),"utf8");
  assert.doesNotMatch(app,/whatsappSecondaryQaCapture|captureSignedSecondaryBatch/);
  const source=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryQaCapture.js"),"utf8");
  assert.doesNotMatch(source,/fetch\(|sendWhatsApp|callGraph|startAutomatedFollowUps|queueIncomingForReply/);
});
test("capture never accepts Neutro identity or unknown secondary account/phone",()=>{
  const config=capture.captureConfig(env());
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"1593376338308612"})),/primary/);
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"1408739622311791"})),/primary/);
  assert.throws(()=>capture.classify(item("messages","1593376338308612"),config),/identity/);
  assert.throws(()=>capture.classify(item("messages","889900","999"),config),/mismatch/);
  assert.throws(()=>capture.classify(item("message_template_status_update"),config),/Unknown field/);
});
test("history and contact consent are independent, plus explicit owner and outbound gates",()=>{
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"false"})),/consent/);
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"false"})),/operator/);
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"})),/outbound/);
  assert.throws(()=>capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:"abc"})),/key/);
  const config=capture.captureConfig(env({WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"false"}));
  assert.equal(capture.classify(item("messages"),config).length,1);
  for(const field of ["history","smb_app_state_sync"])
    assert.throws(()=>capture.classify(item(field),config),/history\/contact consent/);
});
test("secondary capture rejects unverified signed middleware proof before any SQL",async()=>{
  const database=db();
  await assert.rejects(capture.captureSignedSecondaryBatch(item(),{env:env(),database}),/signature/);
  assert.equal(database.queries.length,0);
});
test("QA capture records each distinct signed message, echo, history and app sync exactly once",async()=>{
  for(const field of capture.ALLOWED_FIELDS){
    const database=db();
    const result=await capture.captureSignedSecondaryBatch(
      item(field,"889900","112233",{messages:[{from:"60111111111",text:{body:"private test"}}]}),
      {env:env(),database,signatureVerified:true});
    assert.deepEqual(result,{durable:true,accepted:1,inserted:1});
    assert.equal(database.queries[0].sql,"BEGIN");
    assert.equal(database.queries.at(-1).sql,"COMMIT");
    assert.equal(database.releases,1);
    const insert=database.queries.find(q=>q.sql.includes(
      "INSERT INTO whatsapp_secondary_qa_capture_events"));
    assert.ok(insert);
    assert.equal(insert.args[2],field);
    assert.equal(insert.args[1],900);
    const [fingerprint,, ,encrypted,nonce,tag,bytes,retention]=insert.args;
    assert.match(fingerprint,/^[0-9a-f]{64}$/);
    assert.ok(Buffer.isBuffer(encrypted));
    assert.doesNotMatch(encrypted.toString("utf8"),/private test/);
    assert.equal(nonce.length,12);
    assert.equal(tag.length,16);
    assert.equal(retention,24);
    const decipher=crypto.createDecipheriv("aes-256-gcm",Buffer.alloc(32,15),nonce);
    decipher.setAAD(Buffer.from(fingerprint,"ascii"));
    decipher.setAuthTag(tag);
    const plaintext=Buffer.concat([decipher.update(encrypted),decipher.final()]);
    assert.equal(plaintext.length,bytes);
    assert.match(plaintext.toString("utf8"),/private test/);
    const duplicate=db({duplicate:true});
    const retry=await capture.captureSignedSecondaryBatch(item(field),
      {env:env(),database:duplicate,signatureVerified:true});
    assert.equal(retry.inserted,0);
  }
});
test("missing QA sender binding and SQL failure both rollback and never acknowledge",async()=>{
  for(const options of [{unbound:true},{fail:true}]){
    const database=db(options);
    await assert.rejects(capture.captureSignedSecondaryBatch(item(),{
      env:env(),database,signatureVerified:true
    }));
    assert.equal(database.queries.at(-1).sql,"ROLLBACK");
    assert.equal(database.releases,1);
  }
});
test("the staging SQL is outside auto-run production migration discovery",()=>{
  const sql=fs.readFileSync(path.join(__dirname,
    "../ops/qa-only/001_secondary_encrypted_capture.sql"),"utf8");
  assert.match(sql,/QA NEON ONLY/);
  assert.match(sql,/ciphertext BYTEA/);
  assert.match(sql,/expires_at/);
  const gitRunner=fs.readFileSync(path.join(__dirname,"../src/db/migrationRunner.js"),"utf8");
  assert.match(gitRunner,/MIGRATIONS_DIR/);
  assert.doesNotMatch(gitRunner,/ops\/qa-only/);
});
