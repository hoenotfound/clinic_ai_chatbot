"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const diag = require("../src/services/whatsappWebhookIngressDiagnostics");
const fs = require("node:fs");

const env = Object.freeze({
  WHATSAPP_WEBHOOK_INGRESS_DIAGNOSTICS_ENABLED: "true",
  WHATSAPP_APP_SECRET: "valid-test-app-secret-only",
  WHATSAPP_WABA_ID: "1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_SECONDARY_WABA_ID: "1852014482431209",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
});

function signedBody() {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: env.WHATSAPP_SECONDARY_WABA_ID,
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID },
          contacts: [{
            wa_id: "MY.example-secret",
            profile: { name: "Private Customer", username: "private_handle" },
          }],
          messages: [{
            id: "wamid.HIGH_ENTROPY_REFERENCE_ONE",
            from_user_id: "MY.veryprivatecontact",
            timestamp: "1794390245",
            type: "text",
            text: { body: "My sensitive clinic enquiry with phone +60123456789" },
            referral: {
              source_type: "ad",
              source_id: "private_ad_id",
              source_url: "https://instagram.com/sensitive-ad",
            },
          }, {
            id: "wamid.HIGH_ENTROPY_REFERENCE_TWO",
            from: "60121234567",
            from_user_id: "MY.veryprivatecontact2",
            timestamp: "1794390246",
            type: "text",
            text: { body: "Private second customer" },
          }],
          statuses: [{
            id: "wamid.HIGH_ENTROPY_STATUS",
            status: "delivered",
            recipient_id: "60121234567",
          }],
        },
      }],
    }],
  };
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = true;
  return res;
}

test("summarizes verified secondary BSUID/phone events without patient details", () => {
  const summary = diag.summarizeSignedPayload(
    signedBody(), env, Date.parse("2026-11-11T09:44:07Z")
  );
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.statusCount, 1);
  assert.equal(summary.senderKinds.secondary, 1);
  assert.equal(summary.identityKinds.bsuid_only, 1);
  assert.equal(summary.identityKinds.phone_and_user_id, 1);
  assert.equal(summary.adReferrals, 1);
  assert.equal(summary.maxAgeSeconds, 2);
  assert.equal(summary.ageBuckets.under_1m, 2);
  assert.equal(summary.providerRefs.length, 3);
  assert.equal(summary.providerRefs[0], diag.providerRef("wamid.HIGH_ENTROPY_REFERENCE_ONE"));
  assert.match(summary.providerRefs[0], /^[0-9a-f]{20}$/);
  const serialized = JSON.stringify(summary);
  for (const privateText of [
    "private_handle", "Private Customer", "My sensitive clinic enquiry",
    "60123456789", "MY.veryprivatecontact", "private_ad_id", "instagram.com",
    "wamid.HIGH_ENTROPY_REFERENCE_ONE"
  ]) {
    assert.ok(!serialized.includes(privateText), privateText + " was exposed");
  }
});

test("known sender classification requires both account ID and phone ID", () => {
  assert.equal(diag.senderKind(env.WHATSAPP_SECONDARY_WABA_ID,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env), "secondary");
  assert.equal(diag.senderKind(env.WHATSAPP_SECONDARY_WABA_ID,
    env.WHATSAPP_PHONE_NUMBER_ID, env), "known_account_wrong_or_missing_phone");
  assert.equal(diag.senderKind("unknown", env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env),
    "foreign_or_unknown");
});

test("missing and unrecognized sender identities remain diagnosable", () => {
  for (const [msg,kind] of [
    [{ from_user_id: "MY.test123" }, "bsuid_only"],
    [{ from: "MY.test123" }, "bsuid_only"],
    [{ from: "60121234567" }, "phone"],
    [{ from: "60121234567", from_user_id: "MY.test123" }, "phone_and_user_id"],
    [{ from: "display_only" }, "unrecognized"],
    [{}, "missing"],
  ]) assert.equal(diag.customerKind(msg), kind);
});

test("records the original provider timestamp delay instead of treating late arrivals as fresh", () => {
  assert.deepEqual(diag.ageBucket("1794390245",
    Date.parse("2026-11-11T17:49:33Z")), ["1h_to_24h", 29128]);
  assert.deepEqual(diag.ageBucket("1794390245",
    Date.parse("2026-11-11T09:44:07Z")), ["under_1m", 2]);
  assert.deepEqual(diag.ageBucket("not-a-time", Date.now()), ["unknown", null]);
});

test("signatures are a hard prerequisite for reading customer-event details", () => {
  const request = { method:"POST", path:"/whatsapp/default",
    headers: {}, body:signedBody() };
  const res = response();
  let logged = [];
  const before = console.info;
  console.info = line => logged.push(line);
  try {
    diag.observe(request, res, () => {}, env);
    diag.captureSignedEvent(request, res, () => {}, env);
    res.statusCode = 503;
    res.emit("finish");
  } finally {
    console.info = before;
  }
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0].slice("[WhatsApp signed ingress] ".length)).signature,
    "not_verified");
  assert.ok(!logged[0].includes("Private Customer"));
  assert.ok(!logged[0].includes("providerRefs"));
});

test("signed rejected callbacks retain a provider reference and a controlled rejection code", () => {
  const request = { method:"POST",path:"/whatsapp/default",
    headers: { "x-hub-signature-256": "sha256=synthetic" },body:signedBody() };
  const res = response();
  const logged = [];
  const original = console.info;
  console.info = value => logged.push(value);
  try {
    diag.observe(request,res,()=>{},env);
    diag.markVerified(request,env);
    diag.captureSignedEvent(request,res,()=>{},env);
    diag.markRejected(request,new Error("Unverified Neutro second-number live receiver configuration"));
    res.statusCode=503;
    res.emit("finish");
  } finally { console.info=original; }
  assert.equal(logged.length,1);
  const data=JSON.parse(logged[0].slice("[WhatsApp signed ingress] ".length));
  assert.equal(data.signature,"verified");
  assert.equal(data.route,"app_default_endpoint");
  assert.equal(data.reason,"receiver_config");
  assert.equal(data.httpStatus,503);
  assert.equal(data.messageCount,2);
  assert.equal(data.providerRefs[0],diag.providerRef("wamid.HIGH_ENTROPY_REFERENCE_ONE"));
  assert.ok(!logged[0].includes("private_handle"));
  assert.ok(!logged[0].includes("MY.veryprivatecontact"));
});

test("accepted signed requests record an actual durability attempt", () => {
  const request = { method:"POST",path:"/webhook",
    headers:{"x-hub-signature-256":"sha256=synthetic"},body:signedBody() };
  const res = response();
  const logged = [];
  const original = console.info;
  console.info = line=>logged.push(line);
  try {
    diag.observe(request,res,()=>{},env);
    diag.markVerified(request,env);
    diag.captureSignedEvent(request,res,()=>{},env);
    diag.markPhase(request,"sender_routed");
    diag.markClaim(request,true);
    diag.markClaim(request,false); // duplicate provider replay: not a new insert
    res.emit("finish");
  } finally { console.info=original; }
  const data=JSON.parse(logged[0].slice("[WhatsApp signed ingress] ".length));
  assert.equal(data.phase,"durable_claim");
  assert.equal(data.claimAttempts,2);
  assert.equal(data.claimsInserted,1);
  assert.equal(data.httpStatus,200);
});

test("successful quarantine is distinguishable from a genuinely persisted customer message", () => {
  const request = { method:"POST",path:"/webhook",
    headers:{"x-hub-signature-256":"sha256=synthetic"},body:signedBody() };
  const res=response();
  const logged=[];
  const original=console.info;
  console.info=line=>logged.push(line);
  try {
    diag.observe(request,res,()=>{},env);
    diag.markVerified(request,env);
    diag.captureSignedEvent(request,res,()=>{},env);
    diag.markRouting(request,{acceptedChanges:0,
      quarantined:[{reason:"different_business_phone"}]},0);
    res.emit("finish");
  } finally { console.info=original; }
  const data=JSON.parse(logged[0].slice("[WhatsApp signed ingress] ".length));
  assert.equal(data.httpStatus,200);
  assert.deepEqual(data.routing,{
    acceptedChanges:0,quarantinedChanges:1,parsedCustomers:0,
  });
  assert.equal(data.claimsInserted,0);
});

test("status-only success is not logged, while failures are logged without personal data", () => {
  const request = { method:"POST",path:"/whatsapp/default",
    headers:{"x-hub-signature-256":"sha256=synthetic"},
    body:{object:"whatsapp_business_account",entry:[{
      id:env.WHATSAPP_SECONDARY_WABA_ID,changes:[{
        field:"messages",value:{
          metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
          statuses:[{id:"wamid.CONFIDENTIAL",status:"failed",recipient_id:"60121234567"}],
        },
      }],
    }]},
  };
  const logged = [];
  const original = console.info;
  console.info = line=>logged.push(line);
  try {
    for (const code of [200,503]) {
      const res=response();
      diag.observe(request,res,()=>{},env);
      diag.markVerified(request,env);
      diag.captureSignedEvent(request,res,()=>{},env);
      res.statusCode=code;
      res.emit("finish");
    }
  } finally { console.info=original; }
  assert.equal(logged.length,1);
  assert.ok(logged[0].includes('"statusCount":1'));
  assert.ok(!logged[0].includes("wamid.CONFIDENTIAL"));
  assert.ok(!logged[0].includes("60121234567"));
});

test("bounded analysis never expands a large signed webhook into unbounded logs", () => {
  const body={object:"whatsapp_business_account",entry:Array.from({length:60},()=>({
    id:env.WHATSAPP_SECONDARY_WABA_ID,
    changes:Array.from({length:70},()=>({
      field:"messages",
      value:{metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
        messages:[{id:"wamid.ONE",from_user_id:"MY.xxx",type:"text"}]},
    })),
  }))};
  const result=diag.summarizeSignedPayload(body,env);
  assert.equal(result.entriesSeen,32);
  assert.equal(result.changesSeen,32*64);
  assert.ok(result.truncated);
  assert.equal(result.providerRefs.length,1);
});

test("feature remains disabled unless explicitly enabled, without other-route instrumentation", () => {
  assert.equal(diag.enabled({}),false);
  let count=0;
  diag.observe({method:"POST",path:"/whatsapp/default"},response(),()=>count++,{});
  diag.observe({method:"POST",path:"/api/settings"},response(),()=>count++,env);
  assert.equal(count,2);
});

test("paid default receiver retains config validation both with and without diagnostics", () => {
  const appSource = fs.readFileSync(require.resolve("../src/createApp"), "utf8");
  const from = appSource.indexOf('  app.post("/whatsapp/default",');
  const to = appSource.indexOf('  app.post("/whatsapp/secondary-qa-capture",', from);
  assert.ok(from >= 0 && to > from);
  const route = appSource.slice(from, to);
  assert.match(route, /if \(ingressDiagnostics\.enabled\(\)\) return next\(\);/);
  assert.match(route, /try \{\s*paidDefaultIngress\.configFromEnv\(\);\s*return next\(\);/);
  assert.match(route, /paidDefaultHistoryJsonParser, async \(req, res\) => \{/);
  assert.match(route, /try \{\s*\/\/ Never weaken the default-route config gate in diagnostic mode\.\s*paidDefaultIngress\.configFromEnv\(\);/);
  assert.ok(route.indexOf('paidDefaultIngress.configFromEnv();',
    route.indexOf('paidDefaultHistoryJsonParser')) <
    route.indexOf('productionHistoryReceiver.configured(process.env)'));
});
