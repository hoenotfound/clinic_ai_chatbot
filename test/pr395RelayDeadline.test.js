"use strict";
/**
 * Local-only deadline/replay safety regression tests for the PR395 app-default
 * relay. Every ID and HMAC key is synthetic. No Render, Meta or database I/O.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const {
  dispatchSignedBatch, createRelayServer
} = require("../src/services/whatsappAppDefaultRelay");

const KEY = "pr395-relay-synthetic-deadline-test-key-123";
const OLD = "111111111111111";
const NEW = "222222222222222";
const PHONE = "+60120000000";
const URLS = {
  old: "https://old-synthetic.example.invalid/webhook",
  audit: "https://audit-synthetic.example.invalid/pr395-legacy-lifecycle-webhook",
  pre: "https://pre-synthetic.example.invalid/pr395-preidentity-webhook",
};
const config = Object.freeze({
  appSecret: KEY, verifyToken: "synthetic-verify-token-123",
  secondaryWaba: "", secondaryPhone: PHONE,
  legacyUrl: URLS.old, lifecycleUrl: null,
  bootstrap: {
    legacyWabas: [OLD],
    legacyLifecycleUrl: URLS.audit,
    preidentityUrl: URLS.pre,
  },
});
function signed(){
  const body = {
    object:"whatsapp_business_account",
    entry:[
      {id:OLD,time:1800000000,changes:[
        {field:"messages",value:{metadata:{phone_number_id:"111111"},messages:[
          {id:"wamid.synthetic.123",type:"text",text:{body:"SYNTHETIC"}}]}},
        {field:"account_update",value:{event:"ACCOUNT_DISABLED",phone_number:"+60129998888"}}
      ]},
      {id:NEW,time:1800000000,changes:[
        {field:"account_update",value:{event:"PARTNER_REMOVED",phone_number:PHONE}}
      ]}
    ]
  };
  const raw=Buffer.from(JSON.stringify(body));
  const signature="sha256="+crypto.createHmac("sha256",KEY).update(raw).digest("hex");
  return {raw,signature};
}
function ack(url){
  return {status:200,headers:{get(name){
    if(url===URLS.audit && name==="x-da-legacy-lifecycle-accepted") return "1";
    if(url===URLS.pre && name==="x-da-coexistence-preidentity-accepted") return "1";
    return null;
  }}};
}
function transport({delays={},fail={},records=new Map()}={}){
  const calls=[];
  const fetchImpl=async (url,options)=>{
    assert.ok(Object.values(URLS).includes(url),"Unexpected egress URL");
    assert.equal(options.method,"POST");
    assert.equal(options.redirect,"manual");
    const raw=Buffer.from(options.body);
    assert.equal(options.headers["x-hub-signature-256"],
      "sha256="+crypto.createHmac("sha256",KEY).update(raw).digest("hex"));
    calls.push(url);
    // The simulated receiver commits BEFORE responding (or timing out).
    const event=JSON.parse(raw.toString("utf8"));
    const key=url+":"+crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
    if(!fail[url])records.set(key,event);
    const ms=delays[url]||0;
    if(ms)await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,ms);
      options.signal.addEventListener("abort",()=>{
        clearTimeout(timer);
        reject(Error("synthetic downstream timeout after commit"));
      },{once:true});
    });
    if(fail[url])return{status:503};
    return ack(url);
  };
  return {fetchImpl,calls,records};
}
test("shared deadline succeeds for fast signed mixed forwarding; replay is idempotent",async()=>{
  const fixture=signed(), net=transport();
  const execute=()=>dispatchSignedBatch(fixture.raw,fixture.signature,config,
    net.fetchImpl,{dispatchTimeoutMs:200});
  assert.equal(await execute(),200);
  assert.deepEqual(net.calls,Object.values(URLS));
  assert.equal(net.records.size,3);
  assert.equal(await execute(),200);
  assert.equal(net.records.size,3,"replayed event must not increase committed unique records");
  assert.equal(net.calls.length,6,"each batch attempt makes at most one delivery per route");
});
test("shared budget expires after partial downstream COMMIT; no automatic retry or later sends",async()=>{
  const fixture=signed();
  const net=transport({delays:{[URLS.audit]:110}});
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    net.fetchImpl,{dispatchTimeoutMs:45}),503);
  assert.deepEqual(net.calls,[URLS.old,URLS.audit]);
  assert.equal(net.records.size,2,"legacy and late audit commits are durable before timeout");
  // A SEPARATE, explicitly simulated Meta replay, not an automatic relay retry:
  net.calls.length=0;
  const replay=transport({records:net.records});
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    replay.fetchImpl,{dispatchTimeoutMs:150}),200);
  assert.deepEqual(replay.calls,Object.values(URLS));
  assert.equal(net.records.size,3,"replay completes missing preidentity once");
});
test("missing audit durable ACK is 503 and prevents later forwarding",async()=>{
  const fixture=signed(),net=transport();
  const fetchImpl=async (url,options)=>{
    const response=await net.fetchImpl(url,options);
    if(url===URLS.audit)return{status:200,headers:{get:()=>null}};
    return response;
  };
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    fetchImpl,{dispatchTimeoutMs:150}),503);
  assert.deepEqual(net.calls,[URLS.old,URLS.audit]);
});
test("failed legacy receiver is never retried within the relay",async()=>{
  const fixture=signed(),net=transport({fail:{[URLS.old]:true}});
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    net.fetchImpl,{dispatchTimeoutMs:150}),503);
  assert.deepEqual(net.calls,[URLS.old]);
  assert.equal(net.records.size,0);
});
test("invalid deadline values fail closed before any synthetic forwarding",async()=>{
  const fixture=signed(),net=transport();
  for(const ms of [-1,0,19,30001,Infinity,NaN,"30000"]){
    assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
      net.fetchImpl,{dispatchTimeoutMs:ms}),503);
    assert.throws(()=>createRelayServer(config,{
      fetchImpl:net.fetchImpl,dispatchTimeoutMs:ms
    }),/Invalid relay dispatch deadline/);
  }
  assert.equal(net.calls.length,0);
});
test("foreign WABA cannot trigger a legacy downstream POST in bootstrap",async()=>{
  const fixture=signed();
  const body=JSON.parse(fixture.raw.toString());
  body.entry[0].id="999999999999999";
  const raw=Buffer.from(JSON.stringify(body));
  const signature="sha256="+crypto.createHmac("sha256",KEY).update(raw).digest("hex");
  const net=transport();
  assert.equal(await dispatchSignedBatch(raw,signature,config,
    net.fetchImpl,{dispatchTimeoutMs:150}),503);
  assert.equal(net.calls.length,0);
});

test("one overall budget is shared across fast-enough individual downstream POSTs",async()=>{
  const fixture=signed();
  const net=transport({delays:{[URLS.old]:115,[URLS.audit]:115}});
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    net.fetchImpl,{dispatchTimeoutMs:190}),503);
  assert.deepEqual(net.calls,[URLS.old,URLS.audit],
    "audit should use the remaining time, not a fresh 190ms");
  assert.equal(net.records.size,2);
});
test("late HTTP 200 from noncompliant custom transport cannot bypass deadline",async()=>{
  const fixture=signed();
  const calls=[];
  const late=async(url)=>{
    calls.push(url);
    await new Promise(resolve=>setTimeout(resolve,70)); // ignores AbortSignal
    return ack(url);
  };
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    late,{dispatchTimeoutMs:30}),503);
  assert.deepEqual(calls,[URLS.old]);
});

test("never-settling downstream is bounded without relying on AbortSignal compliance",async()=>{
  const fixture=signed(), calls=[], signals=[];
  const ignoresAbort=(url,options)=>{
    calls.push(url);
    signals.push(options.signal);
    return new Promise(()=>{}); // deliberately never settles or handles abort
  };
  const started=performance.now();
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    ignoresAbort,{dispatchTimeoutMs:50}),503);
  assert.ok(performance.now()-started<950,"relay remained blocked after deadline");
  assert.deepEqual(calls,[URLS.old],"never attempt a second destination");
  assert.equal(signals[0].aborted,true,"best-effort abort must still be signaled");
});
test("late transport ignores abort but upstream responds before its late HTTP 200",async()=>{
  const fixture=signed(), calls=[];
  let lateSettled=false;
  const ignoresAbort=async(url)=>{
    calls.push(url);
    await new Promise(resolve=>setTimeout(resolve,500));
    lateSettled=true;
    return ack(url);
  };
  const started=performance.now();
  assert.equal(await dispatchSignedBatch(fixture.raw,fixture.signature,config,
    ignoresAbort,{dispatchTimeoutMs:50}),503);
  assert.ok(performance.now()-started<950,"relay awaited a late provider response");
  assert.equal(lateSettled,false,"must respond before the late downstream resolves");
  assert.deepEqual(calls,[URLS.old]);
});
test("real local HTTP relay responds 503 for a hanging receiver within bounded deadline",async()=>{
  const fixture=signed(), calls=[];
  const server=createRelayServer(config,{
    dispatchTimeoutMs:65,
    fetchImpl:(_url,options)=>{
      calls.push(options);
      return new Promise(()=>{}); // an uncooperative downstream never answers
    },
  });
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  try {
    const url="http://127.0.0.1:"+server.address().port+"/webhook";
    const started=performance.now();
    const response=await fetch(url,{
      method:"POST",
      headers:{"content-type":"application/json","x-hub-signature-256":fixture.signature},
      body:fixture.raw,
      signal:AbortSignal.timeout(2000),
    });
    assert.equal(response.status,503);
    assert.ok(performance.now()-started<1000,"upstream HTTP request exceeded bounded relay deadline");
    await response.body?.cancel();
    assert.equal(calls.length,1);
    assert.equal(calls[0].signal.aborted,true);
  }finally{
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
