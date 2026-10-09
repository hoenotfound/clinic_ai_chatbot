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

function mockedDatabase({eligible=true,billed=false,sevenDays=false}={}){
  const calls=[];
  const state={status:"idle",reservation_id:null,wamid:null,recipient:null};
  const priced=new Map();
  const query=async(sql,params=[])=>{
    calls.push({sql,params});
    if(sql==="BEGIN" || sql==="COMMIT" || sql==="ROLLBACK")return {rows:[]};
    if(sql.includes("INSERT INTO whatsapp_free_only_send_gate"))return {rows:[]};
    if(sql.includes("FROM whatsapp_free_only_send_gate") && sql.includes("FOR UPDATE"))return {rows:[{...state}]};
    if(sql.includes("FROM whatsapp_free_entry_pricing_evidence WHERE wamid=$1"))
      return {rows:priced.has(params[0])?[priced.get(params[0])]:[]};
    if(sql.includes("AS tripped"))return {rows:[{tripped:billed}]};
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
  assert.match(guard.SEVEN_DAY_PROOF_SQL,/a\.slot_hours>=73/);
  assert.match(guard.VERIFIED_WINDOW_SQL,/\$1::integer - 1/);
});

test("every WhatsApp Cloud API outgoing path is guarded, including templates",()=>{
  const raw=fs.readFileSync(path.join(__dirname,"../src/services/whatsappService.js"),"utf8");
  const templ=fs.readFileSync(path.join(__dirname,"../src/services/whatsappTemplateService.js"),"utf8");
  assert.equal((raw.match(/whatsappZeroCostGuard\.perform\(to/g)||[]).length,7);
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
