"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {verifyJobSender}=require("../src/db/whatsappDeliveryStatusRepo");
const env={
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
  WHATSAPP_WABA_ID:"200000000000001",
};
const primary={whatsapp_sender_id:null,meta_phone_number_id:null,meta_account_id:null};
const ariel={whatsapp_sender_id:2,meta_phone_number_id:"100000000000002",meta_account_id:"200000000000002"};
const registered="2026-10-22T10:00:00.000Z";
function fixture(owner=primary,accountRows=[{created_at:registered}]){
 const calls=[];
 return {
  calls,query:async(sql,args)=>{
   calls.push([sql,args]);
   if(sql.includes("FROM messages m JOIN contacts"))return{rows:owner?[owner]:[]};
   if(sql.includes("SELECT created_at FROM whatsapp_sender_accounts"))return{rows:accountRows};
   throw Error("Unrecognized query "+sql);
  },
 };
}
const oldJob={
  wamid:"wamid.legacy",business_phone_number_id:null,business_account_id:null,
  created_at:"2026-10-20T10:00:00.000Z",
};
test("unique Neutro WAMID created before sender registration recovers historical job",async()=>{
 const f=fixture();
 const result=await verifyJobSender(oldJob,{query:f.query,env});
 assert.equal(result.matched,true);
 assert.match(result.reason,/verified_primary_legacy/);
 assert.equal(f.calls.length,2);
});
test("historical missing metadata after sender registration cannot bypass verified Meta identity",async()=>{
 const f=fixture();
 const result=await verifyJobSender({...oldJob,
  created_at:"2026-10-23T10:00:00.000Z"},{query:f.query,env});
 assert.equal(result.matched,false);
});
test("Ariel cannot borrow Neutro pre-activation status metadata recovery",async()=>{
 const f=fixture(ariel);
 const result=await verifyJobSender(oldJob,{query:f.query,env});
 assert.equal(result.matched,false);
 assert.equal(f.calls.length,1);
});
test("missing/ambiguous provider ownership and missing registration fail closed",async()=>{
 for(const f of [
  fixture(null),fixture(primary,[]),
  fixture(primary,[{created_at:registered},{created_at:registered}]),
 ]) {
  const result=await verifyJobSender(oldJob,{query:f.query,env});
  assert.notEqual(result.matched,true);
 }
 const f=fixture(primary);
 const result=await verifyJobSender({...oldJob,created_at:null},{
  query:f.query,env,
 });
 assert.equal(result.matched,false);
});
test("normal verified Meta sender metadata remains compulsory for current jobs",async()=>{
 const f=fixture(primary);
 const result=await verifyJobSender({
  ...oldJob,business_phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID,
  business_account_id:env.WHATSAPP_WABA_ID,
  created_at:"2026-10-23T10:00:00.000Z",
 },{query:f.query,env});
 assert.equal(result.matched,true);
 assert.equal(f.calls.length,1);
});
