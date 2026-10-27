"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const {assertPr395StagingSafety,stagingWebhookGuard}=require("../src/services/pr395StagingSafety");
const {verifyWebhookSignature}=require("../src/middleware/verifyWebhookSignature");
const {verifyMetaWebhookSignature}=require("../src/middleware/verifyMetaWebhookSignature");

const strong="pr395-staging-strong-secret-value-0123456789";
function safe(overrides={}) {
  return {
    PR395_STAGING_MODE:"true", NODE_ENV:"production",
    PR395_STAGING_BASIC_AUTH_ENABLED:"true",
    PR395_STAGING_BASIC_AUTH_USERNAME:"qa-only",
    PR395_STAGING_BASIC_AUTH_PASSWORD:strong,
    SESSION_SECRET:strong, WHATSAPP_APP_SECRET:strong,
    META_APP_SECRET:strong,
    DATABASE_URL:"postgresql://user:secret@ep-qa123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require",
    PR395_STAGING_EXPECTED_DATABASE_HOST:"ep-qa123.ap-southeast-1.aws.neon.tech",
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"290000000000002",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"290000000000002",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60187004870",
    ...overrides
  };
}
test("PR395 sandbox is inert until explicitly enabled with pinned DB and protected UI",()=>{
  assert.deepEqual(assertPr395StagingSafety(safe()),
    {staging:true,workersDisabled:true,providerProcessingDisabled:true});
  assert.deepEqual(assertPr395StagingSafety({NODE_ENV:"production"}),{staging:false});
  // New personal QA number has not completed Meta authorization yet.
  // Protected mode can clear the prior clinic ID without weakening the gate.
  assert.deepEqual(assertPr395StagingSafety(safe({
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60187004870",
    WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
  })),{staging:true,workersDisabled:true,providerProcessingDisabled:true});
  assert.throws(()=>assertPr395StagingSafety(safe({
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",
  })),/both matching verified phone IDs or neither/);
  assert.throws(()=>assertPr395StagingSafety(safe({
    WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"",
  })),/both matching verified phone IDs or neither/);

});
test("PR395 sandbox fails startup for missing locks, QA DB pin, insecure secrets and active outbound flags",()=>{
  const bad=[
    {PR395_STAGING_BASIC_AUTH_ENABLED:"false"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"110552088553929"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:""},
    {WHATSAPP_SECONDARY_WABA_ID:"1071636698738276"},
    {PR395_STAGING_BASIC_AUTH_PASSWORD:"123"},
    {SESSION_SECRET:""},
    {WHATSAPP_APP_SECRET:""},
    {META_APP_SECRET:""},
    {PR395_STAGING_EXPECTED_DATABASE_HOST:"ep-other.neon.tech"},
    {PR395_STAGING_EXPECTED_DATABASE_HOST:""},
    {DATABASE_URL:"postgresql://user:secret@db.example.com/neondb"},
    {WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"},
    {WHATSAPP_COEXISTENCE_ENABLED:"true"},
    {WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true"},
    {WHATSAPP_FEP_FOLLOWUPS_ENABLED:"true"},
    {PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"true"},
    {NODE_ENV:"development"},
  ];
  for (const item of bad) {
    assert.throws(()=>assertPr395StagingSafety(safe(item)),Error,JSON.stringify(item));
  }
  assert.throws(()=>assertPr395StagingSafety({NODE_ENV:"staging"}), /PR395 staging safeguards/);
  assert.throws(()=>assertPr395StagingSafety({NODE_ENV:"production", PR395_STAGING_BASIC_AUTH_ENABLED:"true"}),/partially enabled/);
});
test("staging never accepts provider POST into business logic",()=>{
  const req={path:"/webhook",method:"POST"};
  const state={called:false,status:null,payload:null};
  const res={set(){return this},status(n){state.status=n;return this},json(v){state.payload=v;return this}};
  stagingWebhookGuard(req,res,()=>{state.called=true},safe());
  assert.equal(state.called,false);
  assert.equal(state.status,503);
  assert.match(state.payload.error,/disabled/);
  stagingWebhookGuard(req,res,()=>{state.called=true},{NODE_ENV:"production"});
  assert.equal(state.called,true);
});
test("both WhatsApp and Meta webhooks require signed raw bytes in staging and accept only valid HMAC",()=>{
  const keys=["NODE_ENV","PR395_STAGING_MODE","PR395_STAGING_BASIC_AUTH_ENABLED",
    "WHATSAPP_APP_SECRET","META_APP_SECRET"];
  const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    process.env.NODE_ENV="staging";
    process.env.PR395_STAGING_MODE="true";
    process.env.PR395_STAGING_BASIC_AUTH_ENABLED="true";
    delete process.env.WHATSAPP_APP_SECRET;
    delete process.env.META_APP_SECRET;
    const buffer=Buffer.from('{"entry":[]}');
    assert.throws(()=>verifyWebhookSignature({headers:{}},null,buffer),/WHATSAPP_APP_SECRET/);
    assert.throws(()=>verifyMetaWebhookSignature({headers:{}},null,buffer),/META_APP_SECRET/);
    process.env.WHATSAPP_APP_SECRET=strong;
    process.env.META_APP_SECRET=strong;
    assert.throws(()=>verifyWebhookSignature({headers:{}},null,buffer),/Missing X-Hub-Signature-256/);
    assert.throws(()=>verifyMetaWebhookSignature({headers:{}},null,buffer),/Missing X-Hub-Signature-256/);
    const signed="sha256="+crypto.createHmac("sha256",strong).update(buffer).digest("hex");
    for(const verifier of [verifyWebhookSignature,verifyMetaWebhookSignature]){
      assert.throws(()=>verifier({headers:{"x-hub-signature-256":"sha256=wrong"}},null,buffer),/signature mismatch/i);
      assert.doesNotThrow(()=>verifier({headers:{"x-hub-signature-256":signed}},null,buffer));
    }
  } finally {for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}}
});
test("PR395 staging gate precedes webhook handlers, and workers are off before readiness",()=>{
  const app=fs.readFileSync(path.join(__dirname,"../src/createApp.js"),"utf8");
  const startup=fs.readFileSync(path.join(__dirname,"../src/services/applicationStartup.js"),"utf8");
  const entry=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(app,/app\.post\("\/webhook", webhookJsonParser, stagingWebhookGuard/);
  assert.match(app,/app\.post\("\/meta-webhook", metaWebhookJsonParser, stagingWebhookGuard/);
  assert.ok(startup.indexOf('if (process.env.PR395_STAGING_MODE === "true")') <
    startup.indexOf("startAutomatedFollowUps();"));
  assert.ok(entry.indexOf("assertPr395StagingSafety(process.env)") <
    entry.indexOf("const app = createApp("));
});

test("provider rehearsal needs verified secondary account pin and all inbound-only switches",()=>{
  const verified={
    ...safe(),
    PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"true",
    PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"true",
    WHATSAPP_WABA_ID:"1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID:"1234567890123",
    WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
    WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
    WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
    WHATSAPP_SECONDARY_TOKEN:"dedicated-secondary-qa-token",
    WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
    WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
    WHATSAPP_COEXISTENCE_ENABLED:"true",
    WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
    WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
    WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
  };
  assert.deepEqual(assertPr395StagingSafety(verified),{
    staging:true,workersDisabled:true,providerProcessingDisabled:false,historyImporterOnly:true
  });
  for(const overrides of [
    {WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"1852014482431209"},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:""},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"1318355951360575"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness"},
    {WHATSAPP_SECONDARY_WABA_ID:""},
    {WHATSAPP_SECONDARY_TOKEN:""},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"},
    {WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true"},
    {WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"false"},
    {PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false"},
    {WHATSAPP_APP_SECRET:"different-secret-0123456789"},
  ]) assert.throws(()=>assertPr395StagingSafety({...verified,...overrides}),Error,
    JSON.stringify(overrides));
  assert.throws(()=>assertPr395StagingSafety({...verified,PR395_STAGING_MODE:"false"}),
    /outside PR395/);
});
test("signed rehearsal only accepts events for its exact second account and phone",()=>{
  const env={
    ...safe(),
    PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"true",
    WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
    WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
    WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
    WHATSAPP_WABA_ID:"1593376338308612",
  };
  const lifecycle={object:"whatsapp_business_account",entry:[{
    id:"222222222222222",changes:[{field:"account_update",value:{
      event:"PARTNER_REMOVED",phone_number:"+60 18-700 4870"
    }}]
  }]};
  const msg={object:"whatsapp_business_account",entry:[{
    id:"222222222222222",changes:[{field:"messages",value:{
      metadata:{phone_number_id:"290000000000002"},
      messages:[{id:"wamid.test",from:"60120000000",type:"text",text:{body:"test"}}]
    }}]
  }]};
  const run=(body,route="/webhook")=>{
    let called=false,code=null;
    const res={set(){return this},status(n){code=n;return this},json(){return this}};
    stagingWebhookGuard({body,path:route},res,()=>{called=true},env);
    return {called,code};
  };
  assert.equal(run(msg).called,true);
  assert.equal(run({...msg, entry:[{...msg.entry[0],changes:[{field:"messages",value:{metadata:{phone_number_id:"1318355951360575"},messages:[{id:"wamid.foreign"}]}}]}]}).code,503);
  assert.equal(run(lifecycle,"/meta-webhook").called,true);
  assert.equal(run(lifecycle,"/webhook").called,true);
  assert.equal(run({...msg,entry:[{...msg.entry[0],id:"1593376338308612"}]}).code,503);
  const status={...msg,entry:[{...msg.entry[0],
    changes:[{field:"messages",value:{
      metadata:{phone_number_id:"290000000000002"},statuses:[{id:"wamid.test"}]
    }}]}]};
  assert.equal(run(status).code,503);
  assert.equal(run(msg,"/meta-webhook").code,503);
  assert.equal(run({object:"whatsapp_business_account",entry:[
    ...msg.entry,...lifecycle.entry
  ]}).called,true);
  const mixed={object:"whatsapp_business_account",entry:[
    ...msg.entry,{id:"1593376338308612",changes:lifecycle.entry[0].changes}
  ]};
  assert.equal(run(mixed).code,503);
});
test("rehearsal does not start AI processing even if a durable inbound claim was enqueued",()=>{
  const worker=fs.readFileSync(path.join(__dirname,"../src/services/inboundProcessingService.js"),"utf8");
  assert.match(worker,/process\.env\.PR395_STAGING_MODE === "true"\) return;/);
  const startup=fs.readFileSync(path.join(__dirname,"../src/services/applicationStartup.js"),"utf8");
  assert.match(startup,/providerRehearsalEnabled\(process\.env\)/);
  assert.match(startup,/coexistenceHistory\.start\(\);/);
});
