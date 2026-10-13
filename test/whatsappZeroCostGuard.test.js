const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const guard=require("../src/services/whatsappZeroCostGuard");
const clinicConfig=require("../src/config/clinicConfig");

function mode(t,enabled=true){
  const previous=clinicConfig.automatedFollowUp;
  const oldAccount=process.env.WHATSAPP_PHONE_NUMBER_ID;
  clinicConfig.automatedFollowUp={
    ...(previous||{}),
    whatsappFreeOnly:{enabled,activatedAt:enabled?"2026-10-09T00:00:00.000Z":null}
  };
  process.env.WHATSAPP_PHONE_NUMBER_ID="123456789";
  t.after(()=>{clinicConfig.automatedFollowUp=previous;
    if(oldAccount===undefined)delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID=oldAccount;});
}

function mockedDatabase({eligible=true,billed=false,sevenDays=false,sessionVerified=eligible}={}){
  const calls=[];
  const state={status:"idle",reservation_id:null,wamid:null,recipient:null};
  const priced=new Map();
  const query=async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql==="BEGIN" || sql==="COMMIT" || sql==="ROLLBACK")return {rows:[]};
    if(sql.includes("INSERT INTO whatsapp_free_only_send_gate"))return {rows:[]};
    if(sql.includes("FROM whatsapp_free_only_send_gate") && sql.includes("FOR UPDATE"))return {rows:[{...state}]};
    if(sql.includes("FROM whatsapp_free_only_send_gate"))return {rows:[{...state}]};
    if(sql.includes("FROM whatsapp_free_entry_pricing_evidence WHERE wamid=$1"))
      return {rows:priced.has(params[0])?[priced.get(params[0])]:[]};
    if(sql.includes("AS tripped"))return {rows:[{tripped:billed}]};
    if(sql===guard.VERIFIED_SESSION_WINDOW_SQL)return {rows:[{verified:sessionVerified}]};
    if(sql.includes("AS verified"))return {rows:[{verified:sevenDays}]};
    if(sql.includes("AS eligible"))return {rows:[{eligible}]};
    if(sql.includes("UPDATE whatsapp_free_only_send_gate")){
      if(sql.includes("status='reserved'"))Object.assign(state,{status:"reserved",reservation_id:params[1],wamid:null,recipient:params[2]});
      if(sql.includes("status='awaiting_pricing'"))Object.assign(state,{status:"awaiting_pricing",wamid:params[2]});
      if(sql.includes("status='idle'"))Object.assign(state,{status:"idle",reservation_id:null,wamid:null,recipient:null});
      if(sql.includes("status='unknown'"))state.status="unknown";
      return {rows:[]};
    }
    if(sql.includes("INSERT INTO whatsapp_free_only_block_events"))return {rows:[]};
    throw new Error("Unexpected SQL: "+sql);
  };
  return {calls,state,priced,query,connect:async()=>({query,release(){}})};
}

test("when switch is off, sends are not changed and do not touch Neon",async t=>{
  mode(t,false);
  const db=mockedDatabase();
  const check=await guard.reserve("601130535053",{database:db});
  assert.deepEqual(check,{allowed:true,reservationId:null});
  assert.equal(db.calls.length,0);
});

test("strict mode fails closed without a priced session",async t=>{
  mode(t);
  const db=mockedDatabase({eligible:false});
  const check=await guard.reserve("601130535053",{database:db});
  assert.equal(check.allowed,false);
  assert.equal(check.code,"zero_cost_unverified_free_entry");
  assert.equal(db.state.status,"idle");
});

test("one account reserves a slot, second send is blocked until Meta confirms nonbillable",async t=>{
  mode(t);
  const db=mockedDatabase();
  const first=await guard.reserve("601130535053",{database:db});
  assert.ok(first.reservationId);
  assert.equal(db.state.status,"reserved");
  const second=await guard.reserve("601130535054",{database:db});
  assert.equal(second.code,"zero_cost_previous_send_unreconciled");
  await guard.complete(first.reservationId,{success:true,wamid:"wamid.test"},db);
  assert.equal(db.state.status,"awaiting_pricing");
  assert.equal((await guard.reserve("601130535053",{database:db})).allowed,false);
  db.priced.set("wamid.test",{pricing_type:"free_entry_point",billable:false,delivery_status:"delivered"});
  const third=await guard.reserve("601130535053",{database:db});
  assert.equal(third.allowed,true);
  assert.notEqual(third.reservationId,first.reservationId);
});

test("a Meta timeout or ambiguous network error is permanently held for review",async t=>{
  mode(t);
  const db=mockedDatabase();
  const first=await guard.reserve("601130535053",{database:db});
  await guard.complete(first.reservationId,{success:false,ambiguous:true},db);
  assert.equal(db.state.status,"unknown");
  assert.equal((await guard.reserve("601130535053",{database:db})).allowed,false);
});

test("definitively rejected 4xx provider request releases reservation",async t=>{
  mode(t);
  const db=mockedDatabase();
  const first=await guard.reserve("601130535053",{database:db});
  await guard.complete(first.reservationId,{success:false,providerStatus:400},db);
  assert.equal(db.state.status,"idle");
  const retry=await guard.reserve("601130535053",{database:db});
  assert.equal(retry.allowed,true);
});

test("confirmed billable callback trips the whole account even for verified ad leads",async t=>{
  mode(t);
  const db=mockedDatabase({billed:true,eligible:true});
  const check=await guard.reserve("601130535053",{database:db});
  assert.equal(check.code,"zero_cost_billing_alarm");
  assert.equal(db.state.status,"idle");
});

test("71h default; 167h only with verified seven-day account evidence",async t=>{
  mode(t);
  const db=mockedDatabase({sevenDays:false});
  process.env.WHATSAPP_FEP_7DAY_VERIFIED="true";
  t.after(()=>delete process.env.WHATSAPP_FEP_7DAY_VERIFIED);
  await guard.reserve("601130535053",{database:db});
  const eligibility=db.calls.find(x=>x.sql.includes("AS eligible"));
  assert.equal(eligibility.params[0],72);
  assert.match(guard.SEVEN_DAY_PROOF_SQL,/observed\.created_at>=opened\.created_at\+interval '72 hours'/);
  assert.match(guard.SEVEN_DAY_PROOF_SQL,/activation\.pricing_type='free_entry_point'/);
  assert.match(guard.SEVEN_DAY_PROOF_SQL,/priced\.billable=false/);
  assert.match(guard.VERIFIED_WINDOW_SQL,/\$1::integer - 1/);
});

test("Inbox verified free-template preview checks Meta evidence without weakening sends", async t => {
  mode(t, false);
  const db = mockedDatabase({ eligible: false });
  assert.equal(await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: db }), false);
  assert.equal(db.calls.some(call => call.sql === guard.VERIFIED_WINDOW_SQL), true);
  db.calls.length = 0;
  assert.equal(await guard.hasVerifiedFreeTemplateWindow("invalid", { database: db }), false);
  assert.equal(db.calls.length, 0);

  const verified = mockedDatabase({ eligible: true });
  assert.equal(await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: verified }), true);
  assert.deepEqual(
    verified.calls.find(call => call.sql === guard.VERIFIED_WINDOW_SQL).params.slice(0, 1),
    [72]
  );
});

test("Inbox preview uses verified seven-day evidence, not the environment flag alone", async t => {
  mode(t, false);
  const oldFlag = process.env.WHATSAPP_FEP_7DAY_VERIFIED;
  process.env.WHATSAPP_FEP_7DAY_VERIFIED = "true";
  t.after(() => {
    if (oldFlag === undefined) delete process.env.WHATSAPP_FEP_7DAY_VERIFIED;
    else process.env.WHATSAPP_FEP_7DAY_VERIFIED = oldFlag;
  });
  const noProof = mockedDatabase({ sevenDays: false });
  await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: noProof });
  assert.equal(noProof.calls.find(call => call.sql === guard.VERIFIED_WINDOW_SQL).params[0], 72);
  const proven = mockedDatabase({ sevenDays: true });
  await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: proven });
  assert.equal(proven.calls.find(call => call.sql === guard.VERIFIED_WINDOW_SQL).params[0], 168);
});

test("Inbox preview honors strict billing blocks", async t => {
  mode(t, true);
  const healthy = mockedDatabase({ eligible: true });
  assert.equal(await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: healthy }), true);
  const billed = mockedDatabase({ billed: true, eligible: true });
  assert.equal(await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: billed }), false);
  const unverified = mockedDatabase({ eligible: false });
  assert.equal(await guard.hasVerifiedFreeTemplateWindow("601130535053", { database: unverified }), false);
});

test("verified free-entry remains visible while strict billing is temporarily held", async t => {
  mode(t);
  const db = mockedDatabase({eligible:true,sessionVerified:true});
  let status = await guard.inspectFreeTemplateWindow("601130535053",{database:db});
  assert.deepEqual(status,{verified:true,sendReady:true,blockedReason:null});

  db.state.status = "reserved";
  status = await guard.inspectFreeTemplateWindow("601130535053",{database:db});
  assert.equal(status.verified,true);
  assert.equal(status.sendReady,false);
  assert.equal(status.blockedReason,"zero_cost_previous_send_unreconciled");

  db.state.status = "idle";
  const bad = mockedDatabase({eligible:false,sessionVerified:true});
  status = await guard.inspectFreeTemplateWindow("601130535053",{database:bad});
  assert.equal(status.verified,true);
  assert.equal(status.sendReady,false);
  const expired = mockedDatabase({eligible:true,sessionVerified:false});
  status = await guard.inspectFreeTemplateWindow("601130535053",{database:expired});
  assert.equal(status.verified,false);
  assert.equal(status.sendReady,false);
  assert.equal(expired.calls.some(x=>x.sql===guard.VERIFIED_WINDOW_SQL),false,
    "expired evidence must not be used to check send readiness");
});

test("evidence-only lookup cannot authorize or reserve a new WhatsApp send", async t => {
  mode(t,false);
  const db = mockedDatabase({eligible:true});
  const status = await guard.inspectFreeTemplateWindow("601130535053",{database:db});
  assert.equal(status.verified,true);
  assert.equal(db.calls.some(x=>/UPDATE whatsapp_free_only_send_gate|INSERT INTO whatsapp_free_only_send_gate/.test(x.sql)),false);
  assert.equal(db.state.status,"idle");
});

test("every WhatsApp Cloud API outgoing path is guarded, including templates",()=>{
  const raw=fs.readFileSync(path.join(__dirname,"../src/services/whatsappService.js"),"utf8");
  const templ=fs.readFileSync(path.join(__dirname,"../src/services/whatsappTemplateService.js"),"utf8");
  assert.equal((raw.match(/whatsappZeroCostGuard\.perform\(to/g)||[]).length,8);
  assert.match(raw,/messageKind:\s*"interactive_consent"/);
  assert.match(templ,/whatsappZeroCostGuard\.perform\(contact\?\.whatsapp_number/);
});

test("strict switch requires acknowledged impact and reports blocked/billing status",()=>{
  const tools=fs.readFileSync(path.join(__dirname,"../portal-frontend/src/pages/Tools.jsx"),"utf8");
  const config=fs.readFileSync(path.join(__dirname,"../src/routes/config.js"),"utf8");
  assert.match(tools,/Block potentially paid WhatsApp sends/);
  assert.match(tools,/freeOnlyImpactConfirmed/);
  assert.match(tools,/billingAlerts/);
  assert.match(config,/acknowledgeImpact !== true/);
  assert.match(config,/freeOnlyGate:/);
});

test("freeform media preflight never substitutes template-only eligibility",async t=>{
  mode(t);
  const db=mockedDatabase({eligible:true});
  const template=await guard.preflightTemplate("601130535053",{database:db});
  const templateQuery=db.calls.find(x=>x.sql===guard.VERIFIED_WINDOW_SQL);
  assert.equal(template.allowed,true);
  assert.equal(templateQuery.params[5],"template");
  db.calls.length=0;
  const media=await guard.preflightFreeform("601130535053",{database:db});
  const mediaQuery=db.calls.find(x=>x.sql===guard.VERIFIED_WINDOW_SQL);
  assert.equal(media.allowed,true);
  assert.equal(mediaQuery.params[5],"freeform");
});
