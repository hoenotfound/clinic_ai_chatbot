"use strict";

// Read-only Meta verification; NO subscription/callback writes, token logging,
// Graph POST, or QR onboarding. Only run with authorized secrets in env.
const REQUIRED_FIELDS = new Set([
  "messages", "account_update", "history",
  "smb_app_state_sync", "smb_message_echoes"
]);
const DEFAULT_GRAPH_VERSION = "v26.0";
const APP_OBJECT = "whatsapp_business_account";

function analyzeSubscriptions({appData,wabaData,appId,expectedNeutroCallback}) {
  if (!Array.isArray(appData?.data) || !Array.isArray(wabaData?.data)) {
    throw Error("Meta did not return both complete app and account subscription lists");
  }
  const found = appData.data.filter(item=>item.object===APP_OBJECT);
  if(found.length!==1)throw Error("Expected exactly one WhatsApp app webhook object");
  const sub=found[0];
  const fields=(sub.fields||[]).map(item=>typeof item==="string"?
    item:typeof item?.name==="string"?item.name:"").filter(Boolean);
  const present=new Set(fields);
  const missing=[...REQUIRED_FIELDS].filter(f=>!present.has(f));
  const appEntry=wabaData.data.filter(item=>String(
    item.whatsapp_business_api_data?.id||item.id||"")===String(appId));
  if(appEntry.length!==1)throw Error("Expected exactly one app subscription on Neutro");
  // Account-level override only. PHONE-level overrides must be read separately.
  const override=appEntry[0].override_callback_uri ??
    appEntry[0].whatsapp_business_api_data?.override_callback_uri ?? null;
  const expected=String(expectedNeutroCallback||"");
  const accountOverrideVerified=Boolean(override && expected && override===expected);
  return {
    appWebhookConfigured:Boolean(sub.callback_url),
    appCallback:sub.callback_url||null,
    appActive:sub.active===true,
    fields:fields.sort(),
    missingRequiredFields:missing,
    accountSubscriptionFound:true,
    accountOverrideVerified,
    accountOverride:override,
    phoneOverrideVerified:false,
    phoneOverride:"not examined by this read-only script",
    cutoverReady:false
  };
}

async function inspectMeta({env=process.env,fetchImpl=global.fetch}={}){
  const appId=String(env.META_APP_ID||"");
  const waba=String(env.WHATSAPP_WABA_ID||"");
  const appToken=String(env.META_APP_ACCESS_TOKEN||"");
  const managementToken=String(env.META_READ_ONLY_MANAGEMENT_TOKEN||"");
  const expectedCallback=String(env.META_EXPECTED_NEUTRO_CALLBACK||"");
  const version=String(env.META_GRAPH_API_VERSION||DEFAULT_GRAPH_VERSION);
  if(!/^\d+$/.test(appId)||!/^\d+$/.test(waba)||
     !/^v\d+\.\d+$/.test(version)||
     !appToken||!managementToken||
     !/^https:\/\/[^/\s]+\/webhook$/.test(expectedCallback))
    throw Error("Missing app/account ID, approved read token or exact expected Neutro URL");
  const get=async(id,token)=>{
    const url="https://graph.facebook.com/"+version+"/"+id;
    const response=await fetchImpl(url,{
      method:"GET",
      headers:{Authorization:"Bearer "+token,Accept:"application/json"},
      signal:AbortSignal.timeout(8000)
    });
    if(!response.ok)throw Error("Graph returned HTTP "+response.status);
    const data=await response.json();
    if(!Array.isArray(data?.data)||data.paging?.next)
      throw Error("Meta response incomplete or paginated; do not infer a verified state");
    return data;
  };
  const appData=await get(appId+"/subscriptions",appToken);
  const wabaData=await get(waba+"/subscribed_apps",managementToken);
  return analyzeSubscriptions({appData,wabaData,appId,expectedNeutroCallback:expectedCallback});
}
if(require.main===module){
  inspectMeta().then(report=>{
    console.log(JSON.stringify({...report,
      cutoverReady:false,
      reason:"Phone-level override and live signed delivery still require independent verification"},null,2));
    process.exitCode=report.appActive&&report.missingRequiredFields.length===0&&
      report.accountOverrideVerified?0:2;
  }).catch(err=>{
    console.error("Meta read-only configuration inspection unavailable:",err.message);
    process.exitCode=2;
  });
}
module.exports={REQUIRED_FIELDS,analyzeSubscriptions,inspectMeta};
