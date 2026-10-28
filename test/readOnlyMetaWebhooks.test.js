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
