"use strict";

// Advisory readiness gate: it cannot scan a QR, alter a callback, subscribe a
// WABA or dispatch Meta's irreversible smb_app_data one-time sync requests.
// Evidence must be independently observed, never inferred from passing CI.
const REQUIRED_FIELDS=Object.freeze([
  "messages","account_update","history","smb_app_state_sync",
  "smb_message_echoes"
]);
const REQUIRED_BEFORE_QR=Object.freeze([
  "productionPrimaryRegressionVerified",
  "productionV079RollbackRehearsed",
  "paidDefaultCallbackDeployedDisabled",
  "signedDefaultCallbackLiveVerified",
  "primaryOverridesUnchanged",
  "metaSubscriptionsVerified",
  "secondaryCaptureReceiverRehearsed",
  "qaCaptureRetentionActive",
  "ownerPrivacyAndContactSyncConsentVerified",
  "oneTimeSyncOperatorAvailable",
  "metaAppDefaultCutoverAndRollbackApproved"
]);
const REQUIRED_AFTER_QR=Object.freeze([
  "graphWabaPhoneOwnershipVerified",
  "metaCoexistenceStatusVerified",
  "senderIdBoundInIsolatedQA",
  "signedSecondaryWebhookLiveVerified",
  "secondaryHistoryImportReady",
  "oneTimeSyncConsentRecorded",
  "authorizedOneTimeSyncOperatorAvailable"
]);
function validateId(value) {
  return typeof value==="string"&&/^\d{1,32}$/.test(value);
}
function inspectQrReadiness({
  env=process.env,
  before={},
  after=null,
  now=new Date()
}={}){
  const unmet=[];
  const expectedPhone=String(env.WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164||"");
  const primaryPhone=String(env.WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164||"");
  if(!/^\+[1-9]\d{7,14}$/.test(expectedPhone)||
     expectedPhone===primaryPhone||expectedPhone==="+60174831336")
    unmet.push("independent_secondary_e164");
  if(env.WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED!=="true")
    unmet.push("production_router_flag_enabled_only_after_cutover_approval");
  if(!REQUIRED_FIELDS.every(f=>
    Array.isArray(before.confirmedFields)&&before.confirmedFields.includes(f)))
    unmet.push("required_meta_webhook_fields");
  for(const key of REQUIRED_BEFORE_QR)if(before[key]!==true)unmet.push(key);
  const secondaryOutbounds=[
    "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
    "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
    "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
    "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
    "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED"
  ];
  if(secondaryOutbounds.some(k=>env[k]==="true"))
    unmet.push("secondary_outbound_disabled");
  const preflightComplete=unmet.length===0;
  const syncUnmet=[];
  if(after){
    if(!validateId(after.wabaId)||!validateId(after.phoneNumberId)||
       after.wabaId===env.WHATSAPP_WABA_ID||
       after.phoneNumberId===env.WHATSAPP_PHONE_NUMBER_ID)
      syncUnmet.push("separate_verified_meta_identity");
    for(const key of REQUIRED_AFTER_QR)if(after[key]!==true)syncUnmet.push(key);
    if(after.historyConsent!==true && after.requestHistory===true)
      syncUnmet.push("history_sharing_consent");
    const completed=new Date(after.onboardingCompletedAt);
    const at=new Date(now);
    if(!Number.isFinite(completed.getTime())||
       !Number.isFinite(at.getTime())||
       completed>at||
       at.getTime()-completed.getTime()>=86400000)
      syncUnmet.push("within_24_hour_one_time_sync_window");
    if(!preflightComplete)syncUnmet.push("pre_qr_safety_gates");
  }
  return {
    qr:{readyForOwnerApproval:preflightComplete,missing:unmet},
    sync:{readyForManualAuthorization:Boolean(after)&&syncUnmet.length===0,
      missing:syncUnmet},
    immutableSafety:{
      automaticQr:false,
      automaticSyncPost:false,
      automaticSecondarySending:false,
      approvalRequired:true
    }
  };
}
module.exports={inspectQrReadiness,REQUIRED_FIELDS,REQUIRED_BEFORE_QR,REQUIRED_AFTER_QR};
