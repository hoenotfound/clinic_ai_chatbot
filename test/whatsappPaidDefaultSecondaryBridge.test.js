"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const bridge=require("../src/services/whatsappPaidDefaultSecondaryBridge");
function event(account,phone,field){
  return{id:account,changes:[{field,value:{metadata:{phone_number_id:phone}}}]};
}
function batch(...entry){return{object:"whatsapp_business_account",entry};}
const env={
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
  WHATSAPP_WABA_ID:"1593376338308612"
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
