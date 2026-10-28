"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const readiness=require("../src/services/startupReadinessService");
const {createApp}=require("../src/createApp");
const capture=require("../src/services/whatsappSecondaryQaCapture");

function signed(secret,body){
  return "sha256="+crypto.createHmac("sha256",secret).update(body).digest("hex");
}
function env(){
  return {WHATSAPP_APP_SECRET:"A".repeat(32),META_APP_SECRET:"A".repeat(32),
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true"};
}
function payload(){
  return JSON.stringify({object:"whatsapp_business_account",entry:[{
    id:"889900",changes:[{field:"messages",value:{
      metadata:{phone_number_id:"112233"},
      messages:[{id:"wamid.1",from:"60120001234",type:"text",text:{body:"hi"}}]
    }}]
  }]});
}
function app(){
  return createApp({
    sessionSecret:"qa-only-http-test-session".repeat(3),
    durablyClaimIncoming:async()=>{throw Error("Neutro must not process secondary");},
    scheduleDurableClaim:async()=>{},queueIncomingForReply:async()=>{}
  });
}
async function server(app,run){
  const s=await new Promise((resolve,reject)=>{
    const x=app.listen(0,"127.0.0.1",()=>resolve(x));x.on("error",reject);
  });
  try{return await run("http://127.0.0.1:"+s.address().port);}
  finally{await new Promise(r=>s.close(r));}
}
function setEnv(t,patch){
  const old=Object.fromEntries(Object.keys(patch).map(k=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(patch)){
    if(v==null)delete process.env[k];else process.env[k]=v;
  }
  t.after(()=>{
    for(const [k,v] of Object.entries(old)){
      if(v==null)delete process.env[k];else process.env[k]=v;
    }
    readiness.resetForTests();
  });
}
test("isolated QA HTTP endpoint remains default-off",async t=>{
  setEnv(t,{...env(),WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"false"});
  readiness.markReady();
  await server(app(),async base=>{
    const raw=payload();
    const response=await fetch(base+"/whatsapp/secondary-qa-capture",{
      method:"POST",
      headers:{"Content-Type":"application/json",
        "X-Hub-Signature-256":signed(process.env.WHATSAPP_APP_SECRET,raw)},
      body:raw
    });
    assert.equal(response.status,503);
  });
});
test("isolated QA HTTP requires signed HMAC and cannot invoke Neutro handler",async t=>{
  setEnv(t,env());readiness.markReady();
  let captures=0;
  const prior=capture.captureSignedSecondaryBatch;
  capture.captureSignedSecondaryBatch=async(_body,opts)=>{
    captures++;assert.equal(opts.signatureVerified,true);
    return{durable:true,accepted:1,inserted:1};
  };
  t.after(()=>{capture.captureSignedSecondaryBatch=prior;});
  await server(app(),async base=>{
    const raw=payload();
    for(const signature of [null,"sha256="+"0".repeat(64)]){
      const response=await fetch(base+"/whatsapp/secondary-qa-capture",{
        method:"POST",
        headers:{"Content-Type":"application/json",
          ...(signature?{"X-Hub-Signature-256":signature}:{})},
        body:raw
      });
      assert.equal(response.status,403);
      assert.equal(captures,0);
    }
    const response=await fetch(base+"/whatsapp/secondary-qa-capture",{
      method:"POST",
      headers:{"Content-Type":"application/json",
        "X-Hub-Signature-256":signed(process.env.WHATSAPP_APP_SECRET,raw)},
      body:raw
    });
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{durable:true,accepted:1,inserted:1});
    assert.equal(captures,1);
  });
});
test("QA failures return 503 without ever forwarding to Neutro AI",async t=>{
  setEnv(t,env());readiness.markReady();
  const prior=capture.captureSignedSecondaryBatch;
  capture.captureSignedSecondaryBatch=async()=>{throw Error("QA unavailable");};
  t.after(()=>{capture.captureSignedSecondaryBatch=prior;});
  const priorLog=console.error;console.error=()=>{};
  t.after(()=>{console.error=priorLog;});
  await server(app(),async base=>{
    const raw=payload();
    const response=await fetch(base+"/whatsapp/secondary-qa-capture",{
      method:"POST",
      headers:{"Content-Type":"application/json",
        "X-Hub-Signature-256":signed(process.env.WHATSAPP_APP_SECRET,raw)},
      body:raw
    });
    assert.equal(response.status,503);
  });
});
