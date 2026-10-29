#!/usr/bin/env node
"use strict";
// Read-only production preflight. Never sends WhatsApp messages, changes a flag,
// prints the bearer token, changes the database or opens the service window.
const { pool }=require("../src/db/db");
const receiver=require("../src/services/whatsappPaidProductionHistoryReceiver");
const EXPECTED={
  key:"neutro_secondary",phone:"1318355951360575",
  waba:"1852014482431209",e164:"+60174831336",
};
const required=[
  "WHATSAPP_MULTI_NUMBER_READ_ENABLED",
  "WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
  "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED",
  "WHATSAPP_SINGLE_SENDER_STRICT_METADATA",
  "WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED",
  "WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED",
];
const staffOnly=[
  "WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED",
  "WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED",
  "WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED",
  "WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED",
];
const forbidden=[
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
  "PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED",
];
async function run(){
  const env=process.env;
  const findings=[];
  const check=(test,label)=>{findings.push({check:label,ok:Boolean(test)});};
  check(env.WHATSAPP_PRIMARY_SENDER_KEY==="neutro","primary pinned");
  check(env.WHATSAPP_SECONDARY_SENDER_KEY===EXPECTED.key &&
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID===EXPECTED.phone &&
    env.WHATSAPP_SECONDARY_WABA_ID===EXPECTED.waba &&
    env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164===EXPECTED.e164,
    "verified secondary sender identity");
  for(const key of required)check(env[key]==="true",key);
  for(const key of forbidden)check(env[key]!=="true",key+" stays OFF");
  check(env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED!=="true" ||
        env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED!=="true",
        "history-only and staff-send must not overlap");
  check(Boolean(String(env.WHATSAPP_SECONDARY_TOKEN||"").trim()),
        "sender-specific Meta token provisioned (value never printed)");
  // Report the remaining activation controls WITHOUT pretending to change them.
  for(const key of staffOnly)check(env[key]==="true",key);
  const s=await pool.query(
    "SELECT id,sender_key,meta_phone_number_id,meta_account_id,state,coexistence_enabled "+
    "FROM whatsapp_sender_accounts WHERE sender_key IN('neutro','neutro_secondary') ORDER BY sender_key");
  const primary=s.rows.find(r=>r.sender_key==="neutro");
  const secondary=s.rows.find(r=>r.sender_key===EXPECTED.key);
  check(s.rows.length===2 && primary?.state==="active" &&
    primary?.meta_phone_number_id===env.WHATSAPP_PHONE_NUMBER_ID,
    "primary sender remains active");
  check(secondary?.state==="active" && secondary?.coexistence_enabled===true &&
    secondary?.meta_phone_number_id===EXPECTED.phone &&
    secondary?.meta_account_id===EXPECTED.waba,
    "secondary sender active with correct phone/WABA");
  const stats=await pool.query(
    "SELECT "+
    "(SELECT COUNT(*)::integer FROM whatsapp_sender_conversations WHERE sender_id=$1 AND state='bound') AS bound_conversations, "+
    "(SELECT COUNT(*)::integer FROM whatsapp_sender_billing_alarms WHERE sender_id=$1) AS billing_alarms, "+
    "(SELECT COUNT(*)::integer FROM whatsapp_sender_coexistence_import_jobs WHERE status<>'completed') AS unfinished_import_jobs",
    [secondary?.id||-1]);
  const counts=stats.rows[0];
  check(Number(counts.bound_conversations)>0,"secondary conversations bound");
  check(Number(counts.billing_alarms)===0,"no latched sender billing alarms");
  check(Number(counts.unfinished_import_jobs)===0,"coexistence import queue drained");
  let liveGate=false;
  try{receiver.assertLiveConfig(env);liveGate=true;}catch{}
  check(liveGate,"live callback validates this exact deployment");
  // Network check is optional and READ-ONLY; never disclose response/token.
  let meta="not_checked";
  if(process.argv.includes("--verify-meta") && env.WHATSAPP_SECONDARY_TOKEN){
    try{
      const u="https://graph.facebook.com/"+(env.META_GRAPH_API_VERSION||"v26.0")+
        "/"+EXPECTED.phone+"?fields=id,display_phone_number";
      const res=await fetch(u,{headers:{Authorization:"Bearer "+env.WHATSAPP_SECONDARY_TOKEN},
        signal:AbortSignal.timeout(12000)});
      if(res.ok){const body=await res.json();meta=body?.id===EXPECTED.phone?"verified":"identity_mismatch";}
      else meta="provider_rejected_http_"+res.status;
    }catch{meta="provider_unavailable";}
    check(meta==="verified","secondary token read-only Meta identity check");
  }
  const failed=findings.filter(f=>!f.ok).map(f=>f.check);
  console.log(JSON.stringify({
    action:"READ_ONLY_PREFLIGHT_NO_SEND",readyForStaffText:failed.length===0,
    boundConversations:Number(counts.bound_conversations),
    outstandingBillingAlarms:Number(counts.billing_alarms),
    unfinishedImportJobs:Number(counts.unfinished_import_jobs),
    metaReadOnlyCheck:meta,checks:findings,
  },null,2));
  process.exitCode=failed.length?1:0;
}
run().catch(err=>{console.error(JSON.stringify({readyForStaffText:false,
  error:"Production preflight unavailable",code:typeof err.code==="string"?err.code:"UNKNOWN"}));
  process.exitCode=1;
}).finally(()=>pool.end().catch(()=>{}));
