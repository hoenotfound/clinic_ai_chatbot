"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {analyzeSubscriptions,inspectMeta,REQUIRED_FIELDS}=require("../scripts/qa/readOnlyMetaWebhooks.cjs");
const fieldNames=[...REQUIRED_FIELDS];
function sub(overrides={}){
  return {appData:{data:[{object:"whatsapp_business_account",active:true,
    callback_url:"https://clinic-ai-chatbot.onrender.com/webhook",
    fields:fieldNames.map(name=>({name}))}]},
    wabaData:{data:[{whatsapp_business_api_data:{id:"1029862536608134"},
      override_callback_uri:"https://neutrosense.dasmarketingsolution.com/webhook"}]},
    appId:"1029862536608134",
    expectedNeutroCallback:"https://neutrosense.dasmarketingsolution.com/webhook",
    ...overrides};
}
test("Meta checker compares all required coex fields without mutating anything",()=>{
  const data=analyzeSubscriptions(sub());
  assert.deepEqual(data.missingRequiredFields,[]);
  assert.equal(data.accountOverrideVerified,true);
  assert.equal(data.phoneOverrideVerified,false);
  assert.equal(data.cutoverReady,false);
});
test("Meta checker detects missing histories, inactive apps and missing Neutro overrides",()=>{
  const incomplete=sub();
  incomplete.appData.data[0].active=false;
  incomplete.appData.data[0].fields=[{name:"messages"}];
  incomplete.wabaData.data[0].override_callback_uri=null;
  const result=analyzeSubscriptions(incomplete);
  assert.ok(result.missingRequiredFields.includes("history"));
  assert.ok(result.missingRequiredFields.includes("account_update"));
  assert.equal(result.accountOverrideVerified,false);
  assert.equal(result.appActive,false);
});
test("read-only Graph checker makes only authenticated GET calls, never logs secrets",async()=>{
  const requests=[];
  const results=[sub().appData,sub().wabaData];
  const report=await inspectMeta({
    env:{META_APP_ID:"1029862536608134",WHATSAPP_WABA_ID:"1593376338308612",
      META_APP_ACCESS_TOKEN:"private-app-token",
      META_READ_ONLY_MANAGEMENT_TOKEN:"private-account-token",
      META_EXPECTED_NEUTRO_CALLBACK:"https://neutrosense.dasmarketingsolution.com/webhook"},
    fetchImpl:async(url,options)=>{
      requests.push({url,options});
      return{ok:true,json:async()=>results[requests.length-1]};
    }
  });
  assert.equal(report.accountOverrideVerified,true);
  assert.equal(requests.length,2);
  assert.ok(requests.every(r=>r.options.method==="GET"));
  assert.ok(requests.every(r=>!r.url.includes("token")));
  assert.deepEqual(requests.map(r=>r.options.headers.Authorization),
    ["Bearer private-app-token","Bearer private-account-token"]);
});
test("pagination and insufficient app ownership never produce a false verified report",async()=>{
  const incomplete=sub();
  incomplete.appData.paging={next:"https://example.com/next"};
  await assert.rejects(inspectMeta({
    env:{META_APP_ID:"1",WHATSAPP_WABA_ID:"2",
      META_APP_ACCESS_TOKEN:"a",META_READ_ONLY_MANAGEMENT_TOKEN:"b",
      META_EXPECTED_NEUTRO_CALLBACK:"https://neutrosense.dasmarketingsolution.com/webhook"},
    fetchImpl:async()=>({ok:true,json:async()=>incomplete.appData})
  }),/incomplete|paginated/);
  assert.throws(()=>analyzeSubscriptions(sub({wabaData:{data:[]}})),
    /one app subscription/);
});

test("Neutro exact primary phone callback and Meta app-default agree on both Graph surfaces",async()=>{
  const args=sub();
  args.appData.data[0].callback_url="https://neutrosense.dasmarketingsolution.com/whatsapp/default";
  args.expectedPhoneId="1408739622311791";
  args.expectedPaidAppCallback=args.appData.data[0].callback_url;
  args.phoneData={data:[{id:args.expectedPhoneId,
    display_phone_number:"+60 11-3053 5053",
    webhook_configuration:{
      whatsapp_business_account:args.expectedNeutroCallback,
      application:args.expectedPaidAppCallback
    }}]};
  const report=analyzeSubscriptions(args);
  assert.equal(report.accountOverrideVerified,true);
  assert.equal(report.phoneOverrideVerified,true);
  assert.equal(report.appDefaultVerified,true);
  assert.equal(report.appPhoneCallbackVerified,true);
  assert.equal(report.cutoverReady,false);
  assert.equal(analyzeSubscriptions({...args,
    phoneData:{data:[{...args.phoneData.data[0],webhook_configuration:{
      ...args.phoneData.data[0].webhook_configuration,whatsapp_business_account:"https://other.example/webhook"}}]}}).phoneOverrideVerified,false);
  assert.throws(()=>analyzeSubscriptions({...args,
    phoneData:{data:[{...args.phoneData.data[0],id:"99999999999"}]}}),/missing or ambiguous/);
});
test("primary phone-level Graph verification is read-only with no token in query string",async()=>{
 const inp=sub();
 inp.appData.data[0].callback_url="https://neutrosense.dasmarketingsolution.com/whatsapp/default";
 const calls=[];
 const token="private-meta-management-token";
 const appToken="private-meta-app-token";
 const env={META_APP_ID:inp.appId,WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  META_APP_ACCESS_TOKEN:appToken,META_READ_ONLY_MANAGEMENT_TOKEN:token,
  META_EXPECTED_NEUTRO_CALLBACK:inp.expectedNeutroCallback,
  META_EXPECTED_PAID_APP_DEFAULT_CALLBACK:inp.appData.data[0].callback_url};
 const report=await inspectMeta({env,fetchImpl:async(url,options)=>{
   calls.push({url,options});
   const responses=[inp.appData,inp.wabaData,{data:[{
     id:env.WHATSAPP_PHONE_NUMBER_ID,
     webhook_configuration:{
       whatsapp_business_account:env.META_EXPECTED_NEUTRO_CALLBACK,
       application:env.META_EXPECTED_PAID_APP_DEFAULT_CALLBACK
     }
   }]}];
   return {ok:true,json:async()=>responses[calls.length-1]};
 }});
 assert.equal(report.phoneOverrideVerified,true);
 assert.equal(report.appPhoneCallbackVerified,true);
 assert.equal(calls.length,3);
 assert.ok(calls.every(c=>c.options.method==="GET" &&
   !c.url.includes(token) && !c.url.includes(appToken)));
 assert.match(calls[2].url,/phone_numbers\?fields=/);
});
