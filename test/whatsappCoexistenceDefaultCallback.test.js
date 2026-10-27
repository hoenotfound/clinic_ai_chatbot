"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const {extractSecondaryLifecycle}=require("../src/services/whatsappCoexistenceAccountUpdateService");

function harness(overrides={},persistFailure=false){
  const s=fs.readFileSync(require.resolve("../src/createApp"),"utf8");
  const begin=s.indexOf('  app.post("/meta-webhook", metaWebhookJsonParser');
  const end=s.indexOf('  app.get("/promo-images/:id"',begin);
  assert.ok(begin>=0&&end>begin);
  let handler=null;
  const writes=[];
  const audits=[];
  const env={
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
    WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60187004870",
    META_APP_SECRET:"same-signed-app",
    WHATSAPP_APP_SECRET:"same-signed-app",
    ...overrides
  };
  vm.runInNewContext(s.slice(begin,end),{
    app:{post:(_p,...a)=>{handler=a.at(-1);}},
    metaWebhookJsonParser(){},stagingWebhookGuard(){},
    process:{env},require,extractSecondaryLifecycle,
    recordQuarantinedWhatsAppChanges:async (events)=>{
      audits.push(...events);
      if(persistFailure)throw Error("synthetic quarantine database failure");
      return events.length;
    },
    persistSecondaryLifecycle:async(events)=>{
      writes.push(...events);
      if(persistFailure)throw Error("synthetic disconnected audit outage");
      return{accepted:true,count:events.length};
    },
    console:{error(){},log(){},warn(){}}
  },{timeout:2000});
  return{writes,audits,async send(body){
    let code=null;
    await handler({body},{sendStatus(value){code=value;return this;}});
    return code;
  }};
}
function callback(event="PARTNER_REMOVED",account="200000000000002"){
  return{object:"whatsapp_business_account",entry:[{
    id:account,changes:[{field:"account_update",value:{
      event,phone_number:"+60 18-700 4870",disconnection_info:{reason:"ACCOUNT_DISCONNECTED"}
    }}]
  }]};
}
test("verified app-level default callback durably handles a secondary disconnect",async()=>{
  const h=harness();
  assert.equal(await h.send(callback()),200);
  assert.equal(h.writes.length,1);
  assert.equal(h.writes[0].eventType,"PARTNER_REMOVED");
});
test("reconnect callback is accepted only as lifecycle review and never a message",async()=>{
  const h=harness();
  assert.equal(await h.send(callback("ACCOUNT_RECONNECTED")),200);
  assert.equal(h.writes[0].eventType,"ACCOUNT_RECONNECTED");
});
test("default callback does not acknowledge WhatsApp messages delivered to wrong route",async()=>{
  const h=harness();
  const cb=callback();
  cb.entry[0].changes.push({field:"messages",value:{
    metadata:{phone_number_id:"100000000000002"},
    messages:[{id:"wamid.unrouted",from:"60129998888",type:"text",text:{body:"hello"}}]
  }});
  assert.equal(await h.send(cb),503);
  assert.equal(h.writes.length,0);
});
test("app-level callback rejects a different app secret, foreign number, or DB outage",async()=>{
  const wrong=harness({META_APP_SECRET:"other-app"});
  assert.equal(await wrong.send(callback()),503);
  assert.equal(wrong.writes.length,0);
  const foreign=harness();
  assert.equal(await foreign.send(callback("PARTNER_REMOVED","200000000000001")),200);
  assert.equal(foreign.writes.length,0);
  assert.equal(foreign.audits.length,1);
  const failing=harness({},true);
  assert.equal(await failing.send(callback()),503);
});

test("unsupported signed account updates are audited and ACKed without retry storm",async()=>{
  const h=harness();
  assert.equal(await h.send(callback("PHONE_NUMBER_STATUS_UPDATE")),200);
  assert.equal(h.writes.length,0);
  assert.equal(h.audits.length,1);
  assert.equal(h.audits[0].field,"account_update");
  assert.equal(h.audits[0].reason,"unsupported_whatsapp_event");
});
test("known disconnect and unrelated signed account update coexist in one durable batch",async()=>{
  const h=harness();
  const input=callback();
  input.entry[0].changes.push({
    field:"account_update",value:{event:"ACCOUNT_VIOLATION"}
  });
  assert.equal(await h.send(input),200);
  assert.equal(h.writes.length,1);
  assert.equal(h.audits.length,1);
});
test("unknown account update audit outage is retryable, not silently acknowledged",async()=>{
  const h=harness({},true);
  assert.equal(await h.send(callback("ACCOUNT_VIOLATION")),503);
  assert.equal(h.audits.length,1);
});
