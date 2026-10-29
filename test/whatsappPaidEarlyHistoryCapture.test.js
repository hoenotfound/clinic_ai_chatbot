"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const hold=require("../src/services/whatsappPaidEarlyHistoryCapture");

const secret="synthetic-meta-app-secret-neutro-early-20261029";
const now=new Date("2026-10-29T06:00:00Z");
const key=Buffer.alloc(32,19).toString("base64");
const base={
 PR395_STAGING_MODE:"false",
 WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OWNER_CONSENT_VERIFIED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL:"2026-10-29T10:00:00Z",
 WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED:"true",
 WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED:"true",
 WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:key,
 WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
 WHATSAPP_WABA_ID:"1593376338308612",WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_PHONE_NUMBER:"+601130535053"
};
const change=(field="history",phone="333333333333333",display="+60 17-483 1336")=>({
 field,value:{
  messaging_product:"whatsapp",
  metadata:{phone_number_id:phone,display_phone_number:display},
  ...(field==="history"?{history:[{metadata:{phase:"1",chunk_order:0,progress:"50"},
   threads:[{id:"60123456789",messages:[{id:"wamid.synthetic-only",
    timestamp:"1761714000",from:"60123456789",type:"text",
    text:{body:"Synthetic sample only"}}]}]}]}:
   {state_sync:[{type:"contact",contact:{phone_number:"60126667788",
     full_name:"synthetic-contact"},action:"add"}]})
 }});
const entry=(id,...changes)=>({id,changes});
const body=(...entries)=>({object:"whatsapp_business_account",entry:entries});
const early=()=>body(entry("222222222222222",change()));
function req(b,valid=true) {
 const raw=Buffer.from(JSON.stringify(b));
 return {body:b,whatsappSignedRawBody:raw,
  headers:{"x-hub-signature-256":"sha256="+
   crypto.createHmac("sha256",valid?secret:"wrong-secret").update(raw).digest("hex")}};
}
function response(){return{statusCode:0,headersSent:false,
 sendStatus(code){this.statusCode=code;this.headersSent=true;return this;}};}
function fakeDb() {
 const records=new Map();const writes=[];
 const client={release(){},
 async query(sql,params=[]){
  writes.push(sql);
  if(sql==="BEGIN" || sql==="COMMIT" || sql==="ROLLBACK")return {rowCount:0};
  if(sql.startsWith("DELETE FROM whatsapp_secondary_early_history_hold WHERE expires_at"))
   return {rowCount:0};
  if(sql.startsWith("INSERT INTO whatsapp_secondary_early_history_hold")){
   if(records.has(params[0]))return {rowCount:0,rows:[]};
   records.set(params[0],{
    fingerprint:params[0],candidate_waba_id:params[1],
    candidate_phone_number_id:params[2],event_field:params[3],
    nonce:params[4],ciphertext:params[5],auth_tag:params[6],payload_bytes:params[7]
   });
   return {rowCount:1,rows:[{fingerprint:params[0]}]};
  }
  throw Error("Unexpected SQL: "+sql);
 }};
 return {records,writes,connect:async()=>client};
}
test("default off and explicit short-lived approval, independent key and no sends are mandatory",()=>{
 assert.equal(hold.enabled({}),false);
 assert.throws(()=>hold.assertCaptureConfig({},now),/OFF/);
 assert.ok(hold.assertCaptureConfig(base,now).key.length===32);
 for(const [field,value] of [
  ["WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OPERATOR_APPROVED","false"],
  ["WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OWNER_CONSENT_VERIFIED","false"],
  ["WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED","false"],
  ["WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL","2026-10-30T08:00:00Z"],
  ["WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL","2026-10-28T00:00:00Z"],
  ["WHATSAPP_SECONDARY_EXPECTED_PHONE_E164","+60178889999"],
  ["WHATSAPP_WABA_ID","not-an-id"],
  ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","true"],
  ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
  ["WHATSAPP_SECONDARY_AI_MEDIA_ENABLED","true"],
  ["WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED","true"],
  ["WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED","true"],
  ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
  ["PR395_STAGING_MODE","true"],
  ["WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY","invalid-key"]
 ])assert.throws(()=>hold.assertCaptureConfig({...base,[field]:value},now),undefined,field);
});
test("only explicit secondary history/contact events are held; unknown foreign history blocks entire batch",()=>{
 const cfg=hold.assertCaptureConfig(base,now);
 const mixed=body(entry(base.WHATSAPP_WABA_ID,change("messages",base.WHATSAPP_PHONE_NUMBER_ID,"+60 11-3053 5053")),
  entry("222222222222222",change(),change("smb_app_state_sync")));
 const parts=hold.partition(mixed,cfg);
 assert.equal(parts.selected.entry[0].changes.length,2);
 assert.equal(parts.remaining.entry[0].id,base.WHATSAPP_WABA_ID);
 for(const bad of [
  body(entry(base.WHATSAPP_WABA_ID,change())),
  body(entry("222222222222222",change("history",base.WHATSAPP_PHONE_NUMBER_ID))),
  body(entry("222222222222222",change("history","333333333333333","+60 12-888 9999"))),
  body(entry("222222222222222",change("history",null))),
  body(entry("not-a-waba",change()))
 ])assert.throws(()=>hold.partition(bad,cfg));
});
test("encrypted hold authenticates event body, account, phone, and tamper without exposing plaintext",()=>{
 const cfg=hold.assertCaptureConfig(base,now),c=change();
 const sealed=hold.seal("222222222222222",c,cfg.key);
 assert.ok(!sealed.ciphertext.toString().includes("Synthetic sample only"));
 const row={fingerprint:sealed.fp,candidate_waba_id:"222222222222222",
  candidate_phone_number_id:sealed.phone,event_field:"history",
  nonce:sealed.nonce,ciphertext:sealed.ciphertext,auth_tag:sealed.tag,
  payload_bytes:sealed.ciphertext.length};
 assert.deepEqual(hold.unseal(row,cfg.key),{accountId:row.candidate_waba_id,change:c});
 assert.throws(()=>hold.unseal({...row,candidate_phone_number_id:"88888888"},cfg.key));
 assert.throws(()=>hold.unseal({...row,auth_tag:Buffer.alloc(16)},cfg.key));
});
test("signed early webhook ACK only after durable hold, replay deduplicates, and never calls primary",async()=>{
 const db=fakeDb();let primary=0;
 const opts={env:base,now,database:db,dispatchPrimary:async()=>{primary++;throw Error("wrong primary")}};
 for(let i=0;i<2;i++){
  const r=response();await hold.dispatch(req(early()),r,()=>{},opts);
  assert.equal(r.statusCode,200);
 }
 assert.equal(db.records.size,1);
 assert.equal(primary,0);
 assert.equal(db.writes.filter(x=>x==="COMMIT").length,2);
 await assert.rejects(()=>hold.dispatch(req(early(),false),response(),()=>{},opts),/Invalid signed/);
 const failed={...db,connect:async()=>({release(){},async query(sql){
  if(sql==="BEGIN"||sql==="ROLLBACK")return {};
  throw Error("database down");
 }})};
 const rejected=response();
 await assert.rejects(()=>hold.dispatch(req(early()),rejected,()=>{},{
  ...opts,database:failed}),/database down/);
 assert.equal(rejected.headersSent,false);
});
test("mixed primary remains delegated only after durable early capture",async()=>{
 const db=fakeDb(),record=[];
 const packet=body(entry("222222222222222",change()),
 entry(base.WHATSAPP_WABA_ID,change("messages",base.WHATSAPP_PHONE_NUMBER_ID,"+60 11-3053 5053")));
 const r=response();
 await hold.dispatch(req(packet),r,()=>{},{
  env:base,now,database:db,
  dispatchPrimary:async(request,res)=>{
   assert.equal(db.records.size,1);
   record.push(request.body.entry[0].id);
   return res.sendStatus(200);
  }});
 assert.equal(r.statusCode,200);assert.deepEqual(record,[base.WHATSAPP_WABA_ID]);
});

const verified={...base,
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"false",
 WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_HANDOFF_OPERATOR_APPROVED:"true",
 WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333333333",
 WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"333333333333333",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true"
};
function verifiedHoldDatabase() {
 const cfg=hold.assertCaptureConfig(base,now);
 const c=change(),sealed=hold.seal("222222222222222",c,cfg.key);
 const record={fingerprint:sealed.fp,candidate_waba_id:"222222222222222",
  candidate_phone_number_id:sealed.phone,event_field:"history",nonce:sealed.nonce,
  ciphertext:sealed.ciphertext,auth_tag:sealed.tag,payload_bytes:sealed.ciphertext.length};
 const state={record,started:0,committed:0,rolledBack:0,staged:0,deleted:0,authorized:true};
 const client={release(){},async query(sql,params=[]) {
  if(sql==="BEGIN"){state.started++;return {};}
  if(sql==="COMMIT"){state.committed++;return {};}
  if(sql==="ROLLBACK"){state.rolledBack++;return {};}
  if(sql.includes("FROM whatsapp_coexistence_onboarding_attempts"))
   return {rows:state.authorized?[{id:1}]:[]};
  if(sql.startsWith("SELECT id FROM whatsapp_sender_accounts"))
   return {rows:[{id:45}]};
  if(sql.startsWith("SELECT fingerprint,candidate_waba_id"))
   return {rows:state.deleted?[]:[record]};
  if(sql.startsWith("SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs"))
   return {rows:[{n:state.staged}]};
  if(sql.startsWith("DELETE FROM whatsapp_secondary_early_history_hold WHERE fingerprint=")){
   state.deleted++;return {rowCount:1};
  }
  throw Error("Unknown SQL: "+sql);
 }};
 return {state,db:{connect:async()=>client}};
}
test("verified handoff refuses release before real authenticated signup, no send or contact mutation",async()=>{
 const {state,db}=verifiedHoldDatabase();
 state.authorized=false;
 await assert.rejects(()=>hold.handoffOnce({env:verified,database:db}),/signup identity not verified/);
 assert.equal(state.deleted,0);
 assert.equal(state.rolledBack,1);
 await assert.rejects(()=>hold.handoffOnce({env:{
  ...verified,WHATSAPP_PAID_SECONDARY_EARLY_HANDOFF_OPERATOR_APPROVED:"false"
 },database:db}),/not approved/);
});
test("verified handoff commits only after importer proof, and rolls back on failure",async()=>{
 const {state,db}=verifiedHoldDatabase();
 await assert.rejects(()=>hold.handoffOnce({env:verified,database:db,
  stageHistory:async()=>{throw Error("synthetic importer unavailable")}
 }),/synthetic importer unavailable/);
 assert.equal(state.deleted,0);
 assert.equal(state.rolledBack,1);
 const result=await hold.handoffOnce({env:verified,database:db,stageHistory:async(packet)=>{
  assert.equal(packet.entry[0].id,"222222222222222");
  assert.equal(packet.entry[0].changes[0].field,"history");
  state.staged=1;return {enabled:true,staged:1};
 }});
 assert.equal(result.transferred,1);
 assert.equal(result.noMessagesSent,true);
 assert.equal(state.deleted,1);
 assert.equal(state.committed,2);
});

test("oversized valid history is deterministically split into encrypted holds before ACK",async()=>{
 const oversized=change();
 const original=Array.from({length:2500},(_,index)=>({
   id:"wamid.synthetic."+String(index).padStart(7,"0"),
   from:"60123456789",timestamp:"1761714000",type:"text",
   text:{body:"synthetic history only "+String(index).padStart(5,"0")+"x".repeat(3600)}
 }));
 oversized.value.history[0].threads[0].messages=original;
 const pieces=hold.splitForHold("222222222222222",oversized);
 assert.ok(pieces.length>1);
 assert.equal(pieces.reduce((n,x)=>n+x.value.history[0].threads[0].messages.length,0),original.length);
 const ids=pieces.flatMap(x=>x.value.history[0].threads[0].messages.map(m=>m.id));
 assert.deepEqual(ids,original.map(m=>m.id));
 const db=fakeDb();
 const packet=body(entry("222222222222222",oversized));
 const first=await hold.stage(packet,{env:base,database:db,now});
 assert.equal(first.inserted,pieces.length);
 assert.equal(db.records.size,pieces.length);
 for(const row of db.records.values()){
   assert.ok(row.ciphertext.length<=8*1024*1024);
   assert.equal(row.nonce.length,12);
   assert.equal(row.auth_tag.length,16);
 }
 const replay=await hold.stage(packet,{env:base,database:db,now});
 assert.equal(replay.inserted,0);
 assert.equal(db.records.size,pieces.length);
});
test("single unbreakable oversized history fragment fails closed",()=>{
 const bad=change();bad.value.history[0].threads[0].messages[0].text.body=
   "synthetic oversized text"+"x".repeat(8*1024*1024);
 assert.throws(()=>hold.splitForHold("222222222222222",bad),/oversized/);
});

test("expired early capture stops selecting receiver but never silently accepts expired holds",async()=>{
  const beforeDeadline=new Date("2026-10-29T09:59:59Z");
  const afterDeadline=new Date("2026-10-29T10:00:01Z");
  assert.equal(hold.enabled(base,beforeDeadline),true);
  assert.equal(hold.enabled(base,afterDeadline),false);
  assert.equal(hold.enabled({...base,WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL:"invalid"},now),false);
  assert.equal(hold.enabled({...base,WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"false"},now),false);
  assert.throws(()=>hold.assertCaptureConfig(base,afterDeadline),/OFF or expired/);
  // Explicitly enabled receiver remains fail-closed for an expired event,
  // but the app router can fall through to its independent guarded handler.
  await assert.rejects(()=>hold.stage(early(),{env:base,now:afterDeadline}),/OFF or expired/);
});
