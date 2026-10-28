"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractSecondaryLifecycle, persistSecondaryLifecycle,
} = require("../src/services/whatsappCoexistenceAccountUpdateService");
function env() {
  return {
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
    WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
    WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness",
  };
}
function body(account,event,number) {
  const value={event};
  if(number!==undefined)value.phone_number=number;
  return {object:"whatsapp_business_account",entry:[
    {id:account,changes:[{field:"account_update",value}]}
  ]};
}
function fakeDatabase() {
  const events=new Set(),queries=[];
  let state="active",coexistence=true;
  return {
    queries,events,
    get sender(){return{state,coexistence}},
    reactivate(){state="active";coexistence=true},
    async connect(){
      return {
        release(){},
        async query(sql,params=[]){
          queries.push({sql,params});
          if(sql.startsWith("SELECT id FROM whatsapp_sender_accounts")) {
            assert.deepEqual(params,["tcm_wellness","200000000000002","100000000000002"]);
            return {rows:[{id:2}]};
          }
          if(sql.startsWith("INSERT INTO whatsapp_sender_coexistence_lifecycle_events")){
            if(events.has(params[0]))return{rowCount:0};
            events.add(params[0]);return{rowCount:1};
          }
          if(sql.startsWith("UPDATE whatsapp_sender_accounts")){
            assert.deepEqual(params,[2]);
            state="disabled";coexistence=false;
            return{rowCount:1};
          }
          return{rows:[],rowCount:0};
        }
      };
    }
  };
}
test("Meta account updates require the exact configured account and secondary E164",()=>{
  const config=env();
  assert.equal(extractSecondaryLifecycle(body("200000000000001","PARTNER_REMOVED","+60174831336"),config).length,0);
  assert.equal(extractSecondaryLifecycle(body("200000000000002","PARTNER_REMOVED","+60129998888"),config).length,0);
  assert.equal(extractSecondaryLifecycle(body("200000000000002","RANDOM_STATUS","+60174831336"),config).length,0);
  assert.equal(extractSecondaryLifecycle(body("200000000000002","PARTNER_REMOVED","+60 17-483 1336"),config).length,1);
  assert.equal(extractSecondaryLifecycle(body("200000000000002","ACCOUNT_OFFBOARDED"),config).length,1);
  assert.equal(extractSecondaryLifecycle(body("200000000000002","ACCOUNT_RECONNECTED"),config).length,1);
  assert.equal(extractSecondaryLifecycle(body("200000000000002","PARTNER_REMOVED"),{
    ...config,WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:""
  }).length,0);
});
test("disconnect disables only the verified secondary sender and repeated event is idempotent",async()=>{
  const database=fakeDatabase(), config=env();
  const updates=extractSecondaryLifecycle(body("200000000000002","PARTNER_REMOVED","+60174831336"),config);
  assert.equal((await persistSecondaryLifecycle(updates,{database,env:config})).count,1);
  assert.equal(database.sender.state,"disabled");
  assert.equal(database.sender.coexistence,false);
  assert.equal((await persistSecondaryLifecycle(updates,{database,env:config})).count,0);
  assert.equal(database.queries.filter(q=>q.sql.startsWith("UPDATE whatsapp_sender_accounts")).length,2,
    "replayed signed disconnect deliberately rechecks suspension; SQL WHERE makes it idempotent");
  assert.equal(database.events.size,1);
});
test("reconnect is recorded but cannot reactivate a disabled secondary sender",async()=>{
  const database=fakeDatabase(),config=env();
  const removed=extractSecondaryLifecycle(body("200000000000002","ACCOUNT_OFFBOARDED"),config);
  const reconnect=extractSecondaryLifecycle(body("200000000000002","ACCOUNT_RECONNECTED"),config);
  await persistSecondaryLifecycle(removed,{database,env:config});
  assert.equal(database.sender.state,"disabled");
  assert.equal((await persistSecondaryLifecycle(reconnect,{database,env:config})).count,1);
  assert.equal(database.sender.state,"disabled");
  assert.equal(database.sender.coexistence,false);
  assert.equal(database.queries.filter(q=>q.sql.startsWith("UPDATE whatsapp_sender_accounts")).length,1);
});
test("unverified sender row fails closed instead of deactivating another business",async()=>{
  const database={async connect(){return{
    async query(sql){if(sql.startsWith("SELECT id"))return{rows:[]};return{}},
    release(){}
  }}};
  const events=extractSecondaryLifecycle(body("200000000000002","PARTNER_REMOVED","+60174831336"),env());
  await assert.rejects(()=>persistSecondaryLifecycle(events,{database,env:env()}),
    /sender identity mismatch/);
});

test("an identical signed removal after manual reactivation disables secondary again",async()=>{
  const database=fakeDatabase(),config=env();
  const payload=body("200000000000002","PARTNER_REMOVED","+60174831336");
  const event=extractSecondaryLifecycle(payload,config);
  await persistSecondaryLifecycle(event,{database,env:config});
  assert.equal(database.sender.state,"disabled");
  database.reactivate(); // independent, explicitly authorized operator action
  assert.equal(database.sender.state,"active");
  const again=await persistSecondaryLifecycle(event,{database,env:config});
  assert.equal(again.count,0,"same fingerprint remains a single audit row");
  assert.equal(database.sender.state,"disabled","duplicate cannot permit live sends");
});
test("entry.time distinguishes separate real disconnect occurrences",()=>{
 const config=env(),p=body("200000000000002","PARTNER_REMOVED","+60174831336");
 p.entry[0].time=1761483600;
 const first=extractSecondaryLifecycle(p,config)[0];
 p.entry[0].time=1761487200;
 const second=extractSecondaryLifecycle(p,config)[0];
 assert.notEqual(first.fingerprint,second.fingerprint);
 assert.equal(first.quarantineFingerprint,second.quarantineFingerprint);
});
