"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const bridge=require("../src/services/whatsappPaidDefaultSecondaryBridge");
function event(account,phone,field){
  return{id:account,changes:[{field,value:{metadata:{phone_number_id:phone}}}]};
}
function batch(...entry){return{object:"whatsapp_business_account",entry};}
const env={
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
  WHATSAPP_APP_SECRET:"x".repeat(32),META_APP_SECRET:"x".repeat(32),
  WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"v".repeat(32),
  WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
  WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60129998888",
  WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
    "postgresql://qa:pass@ep-qa.ap-southeast-1.aws.neon.tech/neondb",
  WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-qa.ap-southeast-1.aws.neon.tech",
  DATABASE_URL:"postgresql://prod:pass@ep-prod.ap-southeast-1.aws.neon.tech/neondb",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:Buffer.alloc(32,17).toString("base64"),
  WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
  WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
  WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
  WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
  WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
  WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60129998888",
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791"
};
test("bridge is OFF by default and leaves the complete Neutro body untouched",()=>{
  const body=batch(event("1593376338308612","1408739622311791","messages"));
  const parts=bridge.splitSecondaryQaChanges(body,{});
  assert.equal(parts.secondary,null);
  assert.equal(parts.remaining,body);
  assert.equal(bridge.splitSecondaryQaChanges(body,env).secondary,null);
});
test("exact secondary WABA and accepted fields are isolated from primary",()=>{
  const body=batch(
    event("1593376338308612","1408739622311791","messages"),
    event("889900","112233","history"),
    event("889900","112233","smb_message_echoes")
  );
  const parts=bridge.splitSecondaryQaChanges(body,env);
  assert.deepEqual(parts.secondary.entry.map(e=>e.id),["889900","889900"]);
  assert.deepEqual(parts.remaining.entry.map(e=>e.id),["1593376338308612"]);
  assert.deepEqual(parts.secondary.entry.map(e=>e.changes[0].field),
    ["history","smb_message_echoes"]);
});
test("secondary-only durable capture gets 200 without invoking Neutro handler",async()=>{
  const body=batch(event("889900","112233","smb_app_state_sync"));
  const res={headersSent:false,code:null,sendStatus(v){
    this.code=v;this.statusCode=v;this.headersSent=true;return this;}};
  let primary=0,capture=0;
  await bridge.dispatchPaidDefaultWithSecondary({body},res,()=>{primary++;},{
    env,dispatchPrimary:()=>{primary++;throw Error("Neutro should not execute");},
    captureSecondary:async(b,options)=>{
      capture++;assert.equal(options.signatureVerified,true);
      assert.equal(b.entry[0].id,"889900");
      return{durable:true,accepted:1,inserted:1};
    }
  });
  assert.equal(res.code,200);
  assert.equal(primary,0);
  assert.equal(capture,1);
});
test("secondary-only failed QA commit cannot return 200",async()=>{
  const body=batch(event("889900","112233","history"));
  const res={headersSent:false,sendStatus(){throw Error("Must not ACK");}};
  await assert.rejects(bridge.dispatchPaidDefaultWithSecondary({body},res,()=>{},{
    env,dispatchPrimary:()=>{throw Error("No primary");},
    captureSecondary:async()=>{throw Error("QA DB unavailable");}
  }),/QA DB unavailable/);
});
test("mixed Neutro and secondary sends Neutro first; QA errors never revoke its ACK",async()=>{
  const body=batch(event("1593376338308612","1408739622311791","messages"),
    event("889900","112233","history"));
  const order=[],logs=[];
  const res={headersSent:false,statusCode:0,
    sendStatus(code){this.headersSent=true;this.statusCode=code;return this;}};
  const original=console.error;console.error=(...args)=>logs.push(args);
  try{
    await bridge.dispatchPaidDefaultWithSecondary({body},res,()=>{},{
      env,
      dispatchPrimary:async(req,resp)=>{
        order.push("Neutro");
        assert.equal(req.body.entry.length,1);
        assert.equal(req.body.entry[0].id,"1593376338308612");
        resp.sendStatus(200);
      },
      captureSecondary:async()=>{
        order.push("secondary");
        throw Error("synthetic QA outage containing secret fixture");
      }
    });
  }finally{console.error=original;}
  assert.deepEqual(order,["Neutro","secondary"]);
  assert.equal(res.statusCode,200);
  assert.equal(logs.length,1);
  assert.equal(JSON.stringify(logs).includes("secret fixture"),false);
});
test("account_update stays with existing audited lifecycle router",()=>{
  const body=batch({id:"889900",changes:[
    {field:"account_update",value:{event:"PARTNER_REMOVED"}},
    {field:"history",value:{metadata:{phone_number_id:"112233"}}}
  ]});
  const parts=bridge.splitSecondaryQaChanges(body,env);
  assert.deepEqual(parts.secondary.entry[0].changes.map(c=>c.field),["history"]);
  assert.deepEqual(parts.remaining.entry[0].changes.map(c=>c.field),["account_update"]);
});
test("foreign accounts, no ID and malformed batch never get classified as secondary",()=>{
  const foreign=batch(event("999999","888888","history"));
  assert.equal(bridge.splitSecondaryQaChanges(foreign,env).secondary,null);
  assert.equal(bridge.splitSecondaryQaChanges(foreign,{
    ...env,WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"not-an-id"}).secondary,null);
  assert.throws(()=>bridge.splitSecondaryQaChanges({entry:[]},env),/Malformed/);
});

test("secondary app-wide alerts are audited without invoking Neutro or exposing payload",async()=>{
  const body=batch({id:"889900",changes:[{field:"security",value:{event:"WARNING"}}]});
  const split=bridge.splitSecondaryQaChanges(body,env);
  assert.equal(split.secondary,null);
  assert.equal(split.remaining,null);
  assert.deepEqual(split.notifications.map(x=>x.field),["security"]);
  const result=[];
  const res={headersSent:false,statusCode:0,
    sendStatus(v){this.statusCode=v;this.headersSent=true;return this;}};
  await bridge.dispatchPaidDefaultWithSecondary({body},res,()=>{throw Error("Neutro!");},{
    env,
    dispatchPrimary:()=>{throw Error("Neutro!");},
    auditSecondary:async(audits,config)=>{
      result.push({audits,config});
      return{durable:true,inserted:1};
    }
  });
  assert.equal(res.statusCode,200);
  assert.equal(result.length,1);
  assert.equal(result[0].audits[0].accountId,"889900");
  assert.equal(result[0].audits[0].phoneId,null);
  assert.match(result[0].audits[0].fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result[0].audits).includes("WARNING"),false);
});
test("wrong secondary phone alert is quarantined, not accepted by bridge",()=>{
  const bad=batch({id:"889900",changes:[{
    field:"security",value:{metadata:{phone_number_id:"1408739622311791"}}
  }]});
  const split=bridge.splitSecondaryQaChanges(bad,env);
  assert.equal(split.notifications.length,0);
  assert.equal(split.remaining.entry[0].changes[0].field,"security");
  const phone=batch({id:"889900",changes:[{
    field:"account_alerts",value:{phone_number:"+601130535053"}
  }]});
  assert.equal(bridge.splitSecondaryQaChanges(phone,env).notifications.length,0);
});
