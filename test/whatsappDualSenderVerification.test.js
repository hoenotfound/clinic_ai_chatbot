"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
 parseArgs,validateDistinctSenders,verifyDualSenderMapping,
}=require("../scripts/verifyWhatsAppDualSenderMapping");

const config={
 WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
 WHATSAPP_WABA_ID:"200000000000001",
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
 WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
 META_APP_ID:"300000000000001",
};
const origin="https://staging.example.test";
function graph({
 absentSecondary=false, wrongApp=false, wrongCallback=false,
 notOnApp=false,wrongPlatform=false,
}={}) {
 const calls=[];
 const fetchImpl=async(url,opts)=>{
  calls.push({url,method:opts.method,authorization:opts.headers?.Authorization});
  const secondary=url.includes("/200000000000002/");
  if(url.includes("/phone_numbers?")){
   const id=secondary?"100000000000002":"100000000000001";
   return{ok:true,status:200,json:async()=>({
    data:absentSecondary&&secondary?[]:[{id}],
   })};
  }
  if(url.includes("/100000000000002?fields=is_on_biz_app,platform_type"))
   return{ok:true,status:200,json:async()=>({
    id:"100000000000002",is_on_biz_app:!notOnApp,
    platform_type:wrongPlatform?"NOT_APPLICABLE":"CLOUD_API"})};
  if(url.includes("/subscribed_apps?"))return{
   ok:true,status:200,json:async()=>({
    data:[{whatsapp_business_api_data:{id:wrongApp?"999999999999999":config.META_APP_ID},
      override_callback_uri:wrongCallback?"https://wrong.example/webhook":origin+"/webhook"}],
   }),
  };
  throw Error("Unexpected URL "+url);
 };
 return {fetchImpl,calls};
}
test("read-only dual verification proves two independent sender owners and never exposes tokens",async()=>{
 const {fetchImpl,calls}=graph();
 const report=await verifyDualSenderMapping({
  env:config,clientBaseUrl:origin,primaryToken:"primary-private",
  secondaryToken:"secondary-private",fetchImpl,
 });
 assert.equal(report.verified,true);
 assert.equal(report.secondary.coexistence.verified,true);
 assert.equal(report.secondary.coexistence.isOnBusinessApp,true);
 assert.equal(report.sameMetaAccount,false);
 assert.equal(report.primary.phoneNumberId,config.WHATSAPP_PHONE_NUMBER_ID);
 assert.equal(report.secondary.phoneNumberId,config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
 assert.equal(calls.length,5);
 assert.ok(calls.every(c=>c.method==="GET"));
 assert.ok(calls.filter(c=>c.url.includes("/200000000000002/") ||
  c.url.includes("/100000000000002?"))
  .every(c=>c.authorization==="Bearer secondary-private"));
 assert.ok(calls.filter(c=>c.url.includes("/200000000000001/"))
  .every(c=>c.authorization==="Bearer primary-private"));
 assert.equal(JSON.stringify(report).includes("private"),false);
});
test("same Meta account two phone IDs is valid and does not conflate identities",async()=>{
 const shared={...config,WHATSAPP_SECONDARY_WABA_ID:config.WHATSAPP_WABA_ID};
 const calls=[];
 const fetchImpl=async(url,opts)=>{
  calls.push({url,token:opts.headers?.Authorization});
  const isPhones=url.includes("/phone_numbers?");
  return {ok:true,json:async()=>url.includes("/100000000000002?")
   ? {id:config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,is_on_biz_app:true,
      platform_type:"CLOUD_API"}
   : isPhones?{
    data:[{id:config.WHATSAPP_PHONE_NUMBER_ID},{id:config.WHATSAPP_SECONDARY_PHONE_NUMBER_ID}],
   }:{data:[{whatsapp_business_api_data:{id:config.META_APP_ID},
    override_callback_uri:origin+"/webhook"}]}};
 };
 const report=await verifyDualSenderMapping({env:shared,clientBaseUrl:origin,
  primaryToken:"primary-private",secondaryToken:"secondary-private",fetchImpl});
 assert.equal(report.verified,true);
 assert.equal(report.sameMetaAccount,true);
 assert.ok(calls.some(c=>c.token==="Bearer secondary-private"));
});
test("wrong phone owner, app or callback always blocks deployment proof",async()=>{
 for(const mode of [{absentSecondary:true},{wrongApp:true},{wrongCallback:true},{notOnApp:true},{wrongPlatform:true}]){
  const {fetchImpl}=graph(mode);
  const report=await verifyDualSenderMapping({env:config,clientBaseUrl:origin,
   primaryToken:"p",secondaryToken:"s",fetchImpl});
  assert.equal(report.verified,false);
 }
});
test("no secondary management token or ambiguous sender identities fails closed",async()=>{
 const {fetchImpl}=graph();
 await assert.rejects(verifyDualSenderMapping({env:config,clientBaseUrl:origin,
  primaryToken:"p",secondaryToken:"",fetchImpl}),/Separate primary and secondary/);
 for(const bad of [
  {...config,WHATSAPP_SECONDARY_PHONE_NUMBER_ID:config.WHATSAPP_PHONE_NUMBER_ID},
  {...config,WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
  {...config,WHATSAPP_SECONDARY_WABA_ID:"unknown"},
 ]){
  assert.throws(()=>validateDistinctSenders(bad),/Two distinct verified/);
 }
 assert.throws(()=>parseArgs(["--token","secret"]),/Do not provide tokens/);
});
