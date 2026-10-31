"use strict";
// Synthetic TLS-only acceptance of the exact pinned PR395 relay code.
// All receiver servers bind 127.0.0.1; only known logical .invalid URLs are mapped.
// No Meta callbacks, real customer data, Neon, Render API, WhatsApp sends or secrets.
const test=require("node:test");
const assert=require("node:assert/strict");
const https=require("node:https");
const http=require("node:http");
const fs=require("node:fs");
const crypto=require("node:crypto");
const src=process.env.PR395_RELAY_SOURCE;
const keyPath=process.env.PR395_TLS_KEY;
const certPath=process.env.PR395_TLS_CERT;
if(!src||!keyPath||!certPath||process.env.NODE_TLS_REJECT_UNAUTHORIZED==="0")
  throw Error("Refusing unpinned/insecure TLS test");
const {createRelayServer,configFromEnv}=require(src);
const SECRET="pr395-fake-meta-hmac-test-secret-not-real";
const VERIFY="pr395-fake-verify-token-for-localhost";
const LEGACY="111111111111111";
const QA="222222222222222";
const PHONE="+60120000000";
const DEST={
  legacy:"https://legacy-pr395-test.invalid/webhook",
  audit:"https://audit-pr395-test.invalid/pr395-legacy-lifecycle-webhook",
  pre:"https://pre-pr395-test.invalid/pr395-preidentity-webhook"
};
const paths={
  legacy:"/webhook",
  audit:"/pr395-legacy-lifecycle-webhook",
  pre:"/pr395-preidentity-webhook"
};
function signed(raw){return "sha256="+crypto.createHmac("sha256",SECRET).update(raw).digest("hex");}
function item(id,changes){return{id,time:1800000000,changes};}
function field(name,value){return{field:name,value};}
function sample(){return{object:"whatsapp_business_account",entry:[
  item(LEGACY,[
    field("messages",{metadata:{phone_number_id:"111111"},messages:[{id:"wamid.synthetic-legacy"}]}),
    field("account_update",{event:"ACCOUNT_DISABLED",phone_number:"+60129999888"})
  ]),
  item(QA,[field("account_update",{event:"PARTNER_REMOVED",phone_number:PHONE})])
]};}
function config(){return configFromEnv({
  WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE:"true",
  WHATSAPP_DEFAULT_RELAY_APP_SECRET:SECRET,
  WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN:VERIFY,
  WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164:PHONE,
  WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID:"",
  WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:LEGACY,
  WHATSAPP_DEFAULT_RELAY_LEGACY_URL:DEST.legacy,
  WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL:DEST.audit,
  WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL:DEST.pre
});}
async function listen(server){await new Promise((ok,bad)=>{
  server.once("error",bad);server.listen(0,"127.0.0.1",ok);
});return server.address().port;}
async function close(server){
  if(!server||!server.listening)return;
  server.closeAllConnections?.();
  await new Promise(ok=>server.close(ok));
}
async function fixture(callback){
  const tls={key:fs.readFileSync(keyPath),cert:fs.readFileSync(certPath)};
  const state=Object.fromEntries(Object.keys(DEST).map(x=>[x,{calls:0,unique:new Set(),fail:false,omitAck:false}]));
  const instances=[];const routes=new Map();let relay;
  try{
    for(const role of Object.keys(DEST)){
      const receiver=https.createServer(tls,async(req,res)=>{
        try{
          if(req.method!=="POST"||req.url!==paths[role])throw Error("Unexpected receiver route");
          const pieces=[];for await(const chunk of req)pieces.push(chunk);
          const raw=Buffer.concat(pieces);
          if(req.headers["x-hub-signature-256"]!==signed(raw)){res.writeHead(403).end();return;}
          const data=JSON.parse(raw.toString("utf8"));
          if(data.object!=="whatsapp_business_account")throw Error("Wrong provider type");
          const changes=data.entry.flatMap(x=>x.changes.map(c=>({account:String(x.id),c})));
          if(changes.length===0)throw Error("Empty batch");
          for(const {account,c} of changes){
            if(role==="legacy"&&(account!==LEGACY||c.field==="account_update"))throw Error("Wrong legacy recipient");
            if(role==="audit"&&(account!==LEGACY||c.field!=="account_update"))throw Error("Wrong audit recipient");
            if(role==="pre"&&(account!==QA||c.field!=="account_update"||c.value.phone_number!==PHONE))
              throw Error("Wrong secondary preidentity recipient");
          }
          state[role].calls++;
          if(state[role].fail){res.writeHead(503).end();return;}
          // In-memory durability simulation: no DB is accessed or mutated.
          for(const change of changes)state[role].unique.add(crypto.createHash("sha256").update(JSON.stringify(change)).digest("hex"));
          let headers={};
          if(role==="audit"&&!state[role].omitAck)headers["x-da-legacy-lifecycle-accepted"]="1";
          if(role==="pre"&&!state[role].omitAck)headers["x-da-coexistence-preidentity-accepted"]="1";
          res.writeHead(200,headers).end();
        }catch(_err){if(!res.headersSent)res.writeHead(503).end();}
      });
      instances.push(receiver);
      const port=await listen(receiver);
      routes.set(DEST[role],"https://127.0.0.1:"+port+paths[role]);
    }
    const fetchImpl=(uri,options)=>{
      assert.ok(routes.has(uri),"Any nonloopback HTTPS egress is forbidden: "+uri);
      return fetch(routes.get(uri),options);
    };
    relay=createRelayServer(config(),{fetchImpl});
    const port=await listen(relay);
    return await callback({base:"http://127.0.0.1:"+port,state});
  }finally{
    await close(relay);
    for(const x of instances)await close(x);
  }
}
async function send(base,data,bad=false){
  const raw=Buffer.from(JSON.stringify(data));
  const response=await fetch(base+"/webhook",{
    method:"POST",headers:{"content-type":"application/json",
      "x-hub-signature-256":bad?"sha256="+("0".repeat(64)):signed(raw)},body:raw,
    signal:AbortSignal.timeout(12000)
  });
  await response.body?.cancel();
  return response.status;
}
function noReceiversReached(state){for(const role of Object.keys(state))assert.equal(state[role].calls,0);}
test("real HTTPS handshake and HMAC-protected mixed forwarding, with in-memory deduplication",async()=>{
  await fixture(async({base,state})=>{
    const challenge=await fetch(base+"/webhook?hub.mode=subscribe&hub.verify_token="+VERIFY+"&hub.challenge=ok");
    assert.equal(challenge.status,200);assert.equal(await challenge.text(),"ok");
    assert.equal(await send(base,sample(),true),403);
    noReceiversReached(state);
    assert.equal(await send(base,sample()),200);
    assert.deepEqual(Object.values(state).map(x=>x.calls),[1,1,1]);
    assert.deepEqual(Object.values(state).map(x=>x.unique.size),[1,1,1]);
    assert.equal(await send(base,sample()),200);
    assert.deepEqual(Object.values(state).map(x=>x.unique.size),[1,1,1]);
  });
});
test("foreign signed WABA and unapproved QA phone reject entire batch before HTTPS egress",async()=>{
  await fixture(async({base,state})=>{
    const foreign={object:"whatsapp_business_account",entry:[item("999999999999999",[field("messages",{messages:[{id:"fake"}]})])]};
    const wrong={object:"whatsapp_business_account",entry:[item(QA,[field("account_update",{event:"PARTNER_REMOVED",phone_number:"+60128888888"})])]};
    const mixed={object:"whatsapp_business_account",entry:[...sample().entry,item("999999999999999",[field("messages",{messages:[]})])]};
    for(const payload of [foreign,wrong,mixed])assert.equal(await send(base,payload),503);
    noReceiversReached(state);
  });
});
test("missing durable legacy ACK returns 503 without sending QA lifecycle to HTTPS",async()=>{
  await fixture(async({base,state})=>{
    state.audit.omitAck=true;
    assert.equal(await send(base,sample()),503);
    assert.equal(state.legacy.unique.size,1);
    assert.equal(state.audit.unique.size,1);
    assert.equal(state.pre.calls,0);
    state.audit.omitAck=false;
    assert.equal(await send(base,sample()),200);
    assert.equal(state.audit.unique.size,1);
    assert.equal(state.pre.unique.size,1);
  });
});
test("simulated HTTPS audit receiver outage returns 503 and blocks QA forwarding",async()=>{
  await fixture(async({base,state})=>{
    state.audit.fail=true;
    assert.equal(await send(base,sample()),503);
    assert.equal(state.pre.calls,0);
    assert.equal(state.audit.unique.size,0);
  });
});
