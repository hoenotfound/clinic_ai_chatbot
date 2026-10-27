"use strict";
/*
 * Manual, wholly LOCAL transport rehearsal of the exact pinned PR #395 relay.
 * The relay implementation is loaded from a GitHub-fetched, SHA-verified file.
 * NO Meta token, customer record, real phone ID, production address or secret.
 * Every downstream URL ends in .invalid and is mapped EXCLUSIVELY to a
 * transient 127.0.0.1 mock receiver. No network fallback is possible.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const PINNED = "19b1bbe00b18e28fb90cdf5755c9ac8ac49484ca";
const PR_SOURCE = process.env.PR395_RELAY_SOURCE;
if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.PR395_APPROVED_SHA !== PINNED ||
    !PR_SOURCE || !PR_SOURCE.startsWith(process.env.RUNNER_TEMP + "/")) {
  throw Error("NO-GO: main-only approved SHA and temporary source are required.");
}
const {createRelayServer,createPreparationRelayServer,configFromEnv} = require(PR_SOURCE);
const SECRET="synthetic-relay-rehearsal-key-never-real-meta-app-secret";
const VERIFY="synthetic-local-verification-token";
const LEGACY="111111111111111";
const QA="222222222222222";
const QA_PHONE="+60120000000";
const OUT={
 legacy:"https://legacy-synthetic-relay.invalid/webhook",
 audit:"https://audit-synthetic-relay.invalid/pr395-legacy-lifecycle-webhook",
 pre:"https://preidentity-synthetic-relay.invalid/pr395-preidentity-webhook"
};
const PATHS={
 legacy:"/webhook",
 audit:"/pr395-legacy-lifecycle-webhook",
 pre:"/pr395-preidentity-webhook"
};
function sleep(n){return new Promise(ok=>setTimeout(ok,n));}
function hmac(raw){return "sha256="+crypto.createHmac("sha256",SECRET).update(raw).digest("hex");}
function payload(entries){return {object:"whatsapp_business_account",entry:entries};}
const entry=(id,changes)=>({id,time:1800000000,changes});
const change=(field,value)=>({field,value});
const msg=change("messages",{metadata:{phone_number_id:"333333333333333"},
  messages:[{id:"wamid.synthetic-legacy-1",type:"text",from:"60120001111",text:{body:"SYNTHETIC"}}]});
const legacyEvent=change("account_update",{event:"ACCOUNT_DISABLED",phone_number:"+60121000000",reference:"synthetic"});
const qaEvent=change("account_update",{event:"PARTNER_REMOVED",phone_number:QA_PHONE,reference:"synthetic"});
function mixed(){return payload([
  entry(LEGACY,[msg,legacyEvent]),
  entry(QA,[qaEvent]),
]);}
function idKey(id,evt){return crypto.createHash("sha256").update(id+":"+JSON.stringify(evt)).digest("hex");}
function createState(){
  return {
    legacy:{requests:0,unique:new Set(),down:false,omitAck:false,delay:0},
    audit:{requests:0,unique:new Set(),down:false,omitAck:false,delay:0},
    pre:{requests:0,unique:new Set(),down:false,omitAck:false,delay:0},
  };
}
async function listen(server){
  await new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  return "http://127.0.0.1:"+server.address().port;
}
async function close(server){
  if(!server.listening)return;
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
function receiver(role,state){
  return http.createServer(async (req,res)=>{
    try {
      const expectedPath=PATHS[role];
      if(req.method!=="POST"||req.url!==expectedPath){res.writeHead(404).end();return;}
      const chunks=[];
      for await(const item of req)chunks.push(item);
      const raw=Buffer.concat(chunks);
      const sig=req.headers["x-hub-signature-256"];
      if(sig!==hmac(raw)){res.writeHead(403).end();return;}
      const data=JSON.parse(raw.toString("utf8"));
      if(data.object!=="whatsapp_business_account"||!Array.isArray(data.entry)||
         !data.entry.length){res.writeHead(503).end();return;}
      const thisState=state[role];
      thisState.requests++;
      if(thisState.down){res.writeHead(503).end();return;}
      const events=[];
      for(const e of data.entry){
        for(const ch of e.changes||[]){
          if(role==="legacy"&&(e.id!==LEGACY||ch.field==="account_update"))
            throw Error("wrong legacy route");
          if(role==="audit"&&(e.id!==LEGACY||ch.field!=="account_update"))
            throw Error("wrong audit route");
          if(role==="pre"&&(e.id!==QA||ch.field!=="account_update"||
             ch.value.phone_number!==QA_PHONE))
            throw Error("wrong preidentity route");
          events.push(idKey(e.id,ch));
        }
      }
      for(const id of events)thisState.unique.add(id); // simulate durable commit
      if(thisState.delay)await sleep(thisState.delay); // response may be late after COMMIT
      const header=(role==="audit"?"x-da-legacy-lifecycle-accepted":
                   role==="pre"?"x-da-coexistence-preidentity-accepted":null);
      res.writeHead(200,header&&!thisState.omitAck?{[header]:"1"}:{}).end();
    }catch(err){
      if(!res.headersSent)res.writeHead(503).end();
    }
  });
}
function config(){
  return configFromEnv({
    WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE:"true",
    WHATSAPP_DEFAULT_RELAY_APP_SECRET:SECRET,
    WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN:VERIFY,
    WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164:QA_PHONE,
    WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID:"",
    WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:LEGACY,
    WHATSAPP_DEFAULT_RELAY_LEGACY_URL:OUT.legacy,
    WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL:OUT.audit,
    WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL:OUT.pre
  });
}
async function fixture(fn){
  const state=createState();
  const servers={
    legacy:receiver("legacy",state),
    audit:receiver("audit",state),
    pre:receiver("pre",state)
  };
  const map=new Map();
  let relay;
  try{
    for(const [name,server] of Object.entries(servers)){
      const address=await listen(server);
      map.set(OUT[name],address+PATHS[name]);
    }
    const fetchImpl=(uri,opts)=>{
      if(!map.has(uri))throw Error("FATAL: attempted nonlocal or unknown relay egress");
      return fetch(map.get(uri),opts);
    };
    relay=createRelayServer(config(),{fetchImpl});
    const url=await listen(relay);
    return await fn({url,state});
  }finally{
    if(relay)await close(relay);
    for(const server of Object.values(servers))await close(server);
  }
}
async function send(url,body,sig){
  const raw=Buffer.from(JSON.stringify(body));
  const response=await fetch(url+"/webhook",{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(20000),
    headers:{"content-type":"application/json",
      "x-hub-signature-256":sig===undefined?hmac(raw):sig},body:raw
  });
  const status=response.status;
  await response.body?.cancel();
  return status;
}
function assertNoWrites(s){
  for(const role of ["legacy","audit","pre"]){
    assert.equal(s[role].requests,0,role+" was reached");
    assert.equal(s[role].unique.size,0,role+" was written");
  }
}
test("preparation relay refuses signed POST and GET challenge without forwarding",async()=>{
  const app=createPreparationRelayServer(),url=await listen(app);
  try{
    assert.equal((await fetch(url+"/health/live")).status,200);
    assert.equal((await fetch(url+"/webhook?hub.mode=subscribe&hub.verify_token="+VERIFY+"&hub.challenge=123")).status,503);
    assert.equal(await send(url,mixed()),503);
  }finally{await close(app);}
});
test("bootstrap challenge and HMAC validation reject unauthorized ingress",async()=>{
  await fixture(async({url,state})=>{
    const correct=await fetch(url+"/webhook?hub.mode=subscribe&hub.verify_token="+VERIFY+"&hub.challenge=abc");
    assert.equal(correct.status,200); assert.equal(await correct.text(),"abc");
    const bad=await fetch(url+"/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc");
    assert.equal(bad.status,403);
    assert.equal(await send(url,mixed(),"sha256="+("0".repeat(64))),403);
    assertNoWrites(state);
  });
});
test("signed realistic mixed batch routes to all three isolated receivers and deduplicates replay",async()=>{
  await fixture(async({url,state})=>{
    assert.equal(await send(url,mixed()),200);
    assert.deepEqual(["legacy","audit","pre"].map(name=>state[name].requests),[1,1,1]);
    assert.deepEqual(["legacy","audit","pre"].map(name=>state[name].unique.size),[1,1,1]);
    assert.equal(await send(url,mixed()),200);
    assert.deepEqual(["legacy","audit","pre"].map(name=>state[name].unique.size),[1,1,1]);
  });
});
test("unknown WABA, wrong phone and message/history at app-default fail closed",async()=>{
  await fixture(async({url,state})=>{
    const foreign=payload([entry("999999999999999",[msg])]);
    const wrongPhone=payload([entry(QA,[change("account_update",{event:"PARTNER_REMOVED",phone_number:"+60128888888"})])]);
    const missingPhone=payload([entry(QA,[change("account_update",{event:"PARTNER_REMOVED"})])]);
    const qaHistory=payload([entry(QA,[change("history",{metadata:{phone_number_id:"444444444444444"},history:[]})])]);
    for(const p of [foreign,wrongPhone,missingPhone,qaHistory])
      assert.equal(await send(url,p),503);
    assertNoWrites(state);
  });
});
test("missing legacy audit COMMIT marker refuses 200 and stops later preidentity forwarding",async()=>{
  await fixture(async({url,state})=>{
    state.audit.omitAck=true;
    assert.equal(await send(url,mixed()),503);
    assert.equal(state.legacy.unique.size,1);
    assert.equal(state.audit.unique.size,1);
    assert.equal(state.pre.requests,0);
  });
});
test("missing preidentity COMMIT marker refuses 200",async()=>{
  await fixture(async({url,state})=>{
    state.pre.omitAck=true;
    assert.equal(await send(url,mixed()),503);
    assert.equal(state.pre.unique.size,1);
  });
});
test("legacy receiver failure and audit DB outage fail closed; replay eventually commits once",async()=>{
  await fixture(async({url,state})=>{
    state.legacy.down=true;
    assert.equal(await send(url,mixed()),503);
    assert.equal(state.audit.requests,0);
    state.legacy.down=false;
    state.audit.down=true;
    assert.equal(await send(url,mixed()),503);
    assert.equal(state.audit.unique.size,0);
    assert.equal(state.pre.requests,0);
    state.audit.down=false;
    assert.equal(await send(url,mixed()),200);
    assert.equal(await send(url,mixed()),200);
    assert.deepEqual(["legacy","audit","pre"].map(name=>state[name].unique.size),[1,1,1]);
  });
});
test("cold/slow downstream COMMIT before 8s timeout results in retryable 503, never a false ACK",async()=>{
  await fixture(async({url,state})=>{
    state.audit.delay=8500; // models late response after durable write
    const started=Date.now();
    assert.equal(await send(url,mixed()),503);
    assert.ok(Date.now()-started>=7300,"test did not exercise the relay's real timeout");
    assert.equal(state.audit.unique.size,1);
    assert.equal(state.pre.requests,0);
    // No automatic relay retry. A later provider replay is explicitly separate.
    state.audit.delay=0;
    assert.equal(await send(url,mixed()),200);
    assert.equal(state.audit.unique.size,1,"late durable insert must be idempotent");
    assert.equal(state.pre.unique.size,1);
  });
});
