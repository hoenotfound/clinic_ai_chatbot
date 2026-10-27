"use strict";

// Pure, no-network activation gate. It does not authorize Embedded Signup,
// mutate a Meta callback, subscribe a WABA, post smb_app_data or send WhatsApp.
// Evidence flags must come from independently observed acceptance tests, not
// inferred from deployment "Live" or from a CI mock receiver success.
const { prepareCoexistenceSyncPlan } = require("./whatsappCoexistenceSyncPlan");
const { credentialVaultReady } = require("./whatsappCoexistenceCredentialVault");

const REQUIRED_META_FIELDS = Object.freeze([
  "messages", "history", "smb_app_state_sync", "smb_message_echoes", "account_update"
]);

function exactDigits(value) {
  const s=String(value||"").trim();
  return /^\d+$/.test(s)?s:null;
}
function validPhone(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value||"").trim());
}
function inspectPr395CoexistenceReadiness({
  env=process.env,
  evidence={},
  afterSignup=null,
  now=new Date(),
}={}) {
  const missingBefore=[];
  const pin=String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164||"").trim();
  const approved=String(env.PR395_STAGING_APPROVED_TEST_PHONE_E164||"").trim();
  const checks=[
    ["isolated_staging",env.PR395_STAGING_MODE==="true"],
    ["qa_sender_pin",env.WHATSAPP_SECONDARY_SENDER_KEY==="coexistence_qa" &&
      validPhone(pin)&&pin===approved&&pin!=="+60174831336"&&
      pin.replace(/\D/g,"")!==String(env.WHATSAPP_PHONE_NUMBER||"").replace(/\D/g,"")],
    ["coexistence_configuration",String(env.META_EMBEDDED_SIGNUP_CONFIG_ID||"").trim()!=="" &&
      env.META_EMBEDDED_SIGNUP_V4_CONFIRMED==="true"],
    ["private_credential_vault",credentialVaultReady(env)],
    ["required_meta_fields",REQUIRED_META_FIELDS.every(field=>
      evidence.confirmedMetaFields instanceof Array &&
      evidence.confirmedMetaFields.includes(field))],
    ["receiver_pre_signup_catch_path_rehearsed",evidence.preSignupCallbackSafetyProven===true],
    ["default_callback_lifecycle_route_rehearsed",evidence.appDefaultLifecycleSafetyProven===true],
    ["history_importer_post_signup_transition_rehearsed",evidence.importerTransitionRehearsed===true],
    ["no_live_outbound",[
      "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
      "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
      "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
      "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED"
    ].every(k=>env[k]!=="true")],
    ["no_real_onboarding_started",evidence.ownerQrAuthorizationGranted!==true],
  ];
  for (const [name,ok] of checks) if(!ok)missingBefore.push(name);
  const canApproveQr=missingBefore.length===0;

  const missingAfter=[];
  let syncPlan=null;
  if(afterSignup){
    const waba=exactDigits(afterSignup.wabaId);
    const phone=exactDigits(afterSignup.phoneNumberId);
    for(const [name,ok] of [
      ["meta_issued_identity",Boolean(waba&&phone)&&
        waba!==String(env.WHATSAPP_WABA_ID||"")&&
        phone!==String(env.WHATSAPP_PHONE_NUMBER_ID||"")&&
        phone!=="1318355951360575"],
      ["meta_phone_owner_verified",afterSignup.graphWabaPhoneOwnershipVerified===true],
      ["coexistence_status_verified",afterSignup.isOnBizApp===true &&
        afterSignup.platformType==="CLOUD_API"],
      ["secondary_vault_token_verified",afterSignup.senderScopedUnexpiredTokenVerified===true],
      ["signed_qa_receiver_live",afterSignup.signedReceiverAcceptanceVerified===true],
      ["waba_callback_override_verified",afterSignup.wabaOverrideMatchesStaging===true],
      ["default_lifecycle_delivery_verified",afterSignup.appDefaultLifecycleSafetyProven===true],
      ["real_importer_can_persist",afterSignup.importerReady===true],
      ["no_previous_one_time_sync",afterSignup.oneTimeSyncAlreadyTriggered!==true],
      ["owner_sync_approval",afterSignup.ownerSyncApproval===true],
    ])if(!ok)missingAfter.push(name);
    if(!missingAfter.length){
      try{
        syncPlan=prepareCoexistenceSyncPlan({
          phoneNumberId:phone,
          onboardingCompletedAt:afterSignup.onboardingCompletedAt,
          historyConsent:afterSignup.historyConsent===true,
          authorized:true,receiverReady:true,importerReady:true,now
        });
        if(!syncPlan.eligibleToRequest)missingAfter.push("one_time_24_hour_window");
      }catch(_){missingAfter.push("valid_onboarding_timestamp");syncPlan=null;}
    }
  }
  const canRequestSync=Boolean(afterSignup)&&missingAfter.length===0;
  return {
    // Advisory only: the operator must independently verify evidence and
    // explicitly authorize the QR / later Meta mutations. Never wire these
    // booleans directly to an automatic production action.
    qr:{preflightComplete:canApproveQr,missing:missingBefore},
    sync:{preflightComplete:canRequestSync,missing:missingAfter,
      requests:canRequestSync?syncPlan.requests:[]},
    callbackGuidance:"Preserve the existing app-level callback. account_update is not covered by WABA callback overrides.",
    automaticNetworkActions:false,
  };
}
module.exports={inspectPr395CoexistenceReadiness,REQUIRED_META_FIELDS};
