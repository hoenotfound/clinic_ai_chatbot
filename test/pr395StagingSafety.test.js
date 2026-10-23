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
    ...overrides
  };
}
test("PR395 sandbox is inert until explicitly enabled with pinned DB and protected UI",()=>{
  assert.deepEqual(assertPr395StagingSafety(safe()),
    {staging:true,workersDisabled:true,providerProcessingDisabled:true});
  assert.deepEqual(assertPr395StagingSafety({NODE_ENV:"production"}),{staging:false});
});
test("PR395 sandbox fails startup for missing locks, QA DB pin, insecure secrets and active outbound flags",()=>{
  const bad=[
    {PR395_STAGING_BASIC_AUTH_ENABLED:"false"},
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
  assert.throws(()=>assertPr395StagingSafety({NODE_ENV:"staging"}), /PR395_STAGING_MODE/);
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
