"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const readiness=require("../src/services/startupReadinessService");
const {createApp}=require("../src/createApp");
const secret="synthetic-meta-app-secret-signed-history-production";
const config={
  NODE_ENV:"test",
  PR395_STAGING_MODE:"false",
  WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"private-synthetic-paid-verify-token",
  WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333333333",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"333333333333333",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SECONDARY_TOKEN:"synthetic-separate-token-never-sent",
  WHATSAPP_COEXISTENCE_ENABLED:"false",
  WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
  WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"true",
};
function setEnv(t,variables){
  const old={};
  for(const [k,v] of Object.entries(variables)){
    old[k]=process.env[k];
    if(v===undefined)delete process.env[k];
    else process.env[k]=v;
  }
  t.after(()=>{
    for(const [k,v] of Object.entries(old)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
    readiness.resetForTests();
  });
}
async function serve(app,fn){
  const server=await new Promise((resolve,reject)=>{
    const s=app.listen(0,"127.0.0.1",()=>resolve(s));
    s.on("error",reject);
  });
  try{return await fn("http://127.0.0.1:"+server.address().port);}
  finally{await new Promise(r=>server.close(r));}
}
function payload(){
  return JSON.stringify({object:"whatsapp_business_account",entry:[{
    id:config.WHATSAPP_SECONDARY_WABA_ID,
    changes:[{field:"history",value:{
      metadata:{phone_number_id:config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
      history:[{threads:[{id:"60125558888",messages:[]}]}]
    }}]
  }]});
}
async function post(url,body,overrideSignature){
  const sig="sha256="+crypto.createHmac("sha256",secret).update(body).digest("hex");
  return fetch(url+"/whatsapp/default",{
    method:"POST",headers:{"Content-Type":"application/json",
      "X-Hub-Signature-256":overrideSignature===undefined?sig:overrideSignature},
    body
  });
}
function app(stage){
  return createApp({
    sessionSecret:"synthetic-staging-session-secret-1234567890",
    durablyClaimIncoming:async()=>{throw Error("Secondary must not enter primary");},
    scheduleDurableClaim:async()=>{},
    queueIncomingForReply:async()=>{},
    stagePaidSecondaryHistory:stage,
  });
}
test("full HTTP Meta HMAC -> primary-paid route -> durable secondary staging -> 200, replay safe",async t=>{
  setEnv(t,config);
  readiness.markReady();
  const received=[];
  await serve(app(async(body,options)=>{
    received.push({body,options});
    return{enabled:true,staged:received.length===1?1:0};
  }),async url=>{
    let p=await post(url,payload());
    assert.equal(p.status,200);
    p=await post(url,payload());
    assert.equal(p.status,200);
    assert.equal(received.length,2);
    assert.equal(received[0].body.entry[0].id,config.WHATSAPP_SECONDARY_WABA_ID);
  });
});
test("full HTTP unsigned or tampered Meta callback is rejected before staging",async t=>{
  setEnv(t,config);
  readiness.markReady();
  let writes=0;
  await serve(app(async()=>{writes++;return{enabled:true,staged:1};}),async url=>{
    const body=payload();
    const unsigned=await fetch(url+"/whatsapp/default",{
      method:"POST",headers:{"Content-Type":"application/json"},body
    });
    assert.notEqual(unsigned.status,200);
    const tampered=await post(url,body,"sha256="+"0".repeat(64));
    assert.notEqual(tampered.status,200);
    assert.equal(writes,0);
  });
});
test("full HTTP returns 503 when history job storage is unavailable, never falsely ACKs",async t=>{
  setEnv(t,config);
  readiness.markReady();
  await serve(app(async()=>{throw Error("synthetic storage unavailable");}),async url=>{
    const response=await post(url,payload());
    assert.equal(response.status,503);
  });
});
test("full HTTP production history receiver OFF remains fail-closed on secondary account",async t=>{
  setEnv(t,{...config,WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"false",
    WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"false",
    WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"false",
    WHATSAPP_MULTI_NUMBER_READ_ENABLED:"false"});
  readiness.markReady();
  await serve(app(async()=>{throw Error("Never stage when OFF");}),async url=>{
    const response=await post(url,payload());
    assert.equal(response.status,503);
  });
});


const liveOnlyConfig={
  ...config,
  WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"false",
  WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"false",
  WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"false",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"false",
  WHATSAPP_SECONDARY_TOKEN:"",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"false",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false",
  WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
};
function liveMessage(account,phone,id){
  return JSON.stringify({object:"whatsapp_business_account",entry:[{
    id:account,changes:[{field:"messages",value:{
      messaging_product:"whatsapp",
      metadata:{phone_number_id:phone,display_phone_number:"synthetic"},
      messages:[{id,from:"60129990001",timestamp:"1793250000",
        type:"text",text:{body:"Synthetic HTTP test only"}}]
    }}]
  }]});
}
function liveOnlyApp(onClaim){
  return createApp({
    sessionSecret:"synthetic-session-secret-for-live-only-http",
    durablyClaimIncoming:onClaim,
    scheduleDurableClaim:async()=>{},
    queueIncomingForReply:async()=>{throw Error("No AI send during live-only webhook test");},
  });
}
test("live-only signed HTTP accepts exact second sender with no outbound token, preserves primary /webhook",async t=>{
  setEnv(t,liveOnlyConfig);readiness.markReady();
  const claimed=[];
  await serve(liveOnlyApp(async(key,incoming)=>{
    claimed.push({key,account:incoming.businessAccountId,
      phone:incoming.businessPhoneNumberId,wamid:incoming.id});
    return {syntheticClaim:true};
  }),async url=>{
    const secondary=liveMessage(config.WHATSAPP_SECONDARY_WABA_ID,
      config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,"wamid.synthetic-secondary-inbound");
    const primary=liveMessage(config.WHATSAPP_WABA_ID,
      config.WHATSAPP_PHONE_NUMBER_ID,"wamid.synthetic-primary-inbound");
    assert.equal((await post(url,secondary)).status,200,
      "signed secondary must be routed by real Express JSON parser and verified twice");
    // Old production entry point is deliberately unchanged.
    const signedPrimary="sha256="+crypto.createHmac("sha256",secret)
      .update(primary).digest("hex");
    const legacy=await fetch(url+"/webhook",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Hub-Signature-256":signedPrimary},
      body:primary
    });
    assert.equal(legacy.status,200);
    assert.equal(claimed.length,2);
    assert.equal(claimed[0].account,config.WHATSAPP_SECONDARY_WABA_ID);
    assert.equal(claimed[0].phone,config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
    assert.equal(claimed[0].key,
      "whatsapp:"+config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID+":60129990001");
    assert.equal(claimed[1].account,config.WHATSAPP_WABA_ID);
    assert.equal(claimed[1].phone,config.WHATSAPP_PHONE_NUMBER_ID);
  });
});
test("live-only signed HTTP fails closed for missing/forged HMAC, wrong phone, foreign WABA and history",async t=>{
  setEnv(t,liveOnlyConfig);readiness.markReady();
  let claims=0;
  await serve(liveOnlyApp(async()=>{claims++;return {syntheticClaim:true};}),async url=>{
    const correct=liveMessage(config.WHATSAPP_SECONDARY_WABA_ID,
      config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,"wamid.synthetic-secondary-inbound");
    const unsigned=await fetch(url+"/whatsapp/default",{
      method:"POST",headers:{"Content-Type":"application/json"},body:correct
    });
    assert.equal(unsigned.status,403);
    assert.equal((await post(url,correct,"sha256="+"0".repeat(64))).status,403);
    const wrongPhone=liveMessage(config.WHATSAPP_SECONDARY_WABA_ID,
      config.WHATSAPP_PHONE_NUMBER_ID,"wamid.synthetic-wrong-phone");
    assert.equal((await post(url,wrongPhone)).status,503);
    const foreign=liveMessage("999999999999999",
      config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,"wamid.synthetic-foreign");
    assert.equal((await post(url,foreign)).status,503);
    assert.equal((await post(url,payload())).status,503,
      "historical import must remain OFF for live-only receiver");
    assert.equal(claims,0);
  });
});
