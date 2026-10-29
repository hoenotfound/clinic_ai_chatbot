"use strict";
// Operator-only recheck after Meta Embedded Signup. No callback, outbound,
// automatic retry or history sync. Only an independently verified status may
// promote the exact signed-up, encrypted-credential-backed attempt.
const {pool}=require("../db/db");
const {loadValidatedCredentialForSetup}=require("../db/whatsappCoexistenceOnboardingRepo");
const {fetchPhoneNumbers}=require("./whatsappCoexistenceOnboardingService");

const TARGET="+60174831336";
const digits=value=>String(value||"").replace(/\\D/g,"");
const numeric=value=>typeof value==="string" && /^\\d{1,32}$/.test(value);
function assertTarget({attemptId,wabaId,phoneNumberId},env){
  if(!Number.isSafeInteger(attemptId)||attemptId<1||
     !numeric(wabaId)||!numeric(phoneNumberId)||
     env.PR395_STAGING_MODE==="true"||
     env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164!==TARGET||
     env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary"||
     wabaId!==env.WHATSAPP_SECONDARY_WABA_ID||
     phoneNumberId!==env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||
     wabaId===env.WHATSAPP_WABA_ID ||
     phoneNumberId===env.WHATSAPP_PHONE_NUMBER_ID||
     digits(env.WHATSAPP_PHONE_NUMBER)===digits(TARGET))
    throw Error("Exact verified nonprimary Neutro Coexistence target required.");
}
async function recheck({
  attemptId,wabaId,phoneNumberId,execute=false
},{
  env=process.env,database=pool,fetchImpl=global.fetch,
  loadCredential=loadValidatedCredentialForSetup,
  lookupPhones=fetchPhoneNumbers
}={}){
  assertTarget({attemptId,wabaId,phoneNumberId},env);
  if(execute && env.WHATSAPP_SECONDARY_STATUS_RECHECK_OPERATOR_APPROVED!=="true")
    throw Error("Coexistence status write requires separate operator approval.");
  const attempt=await database.query(
    "SELECT id,display_phone_number FROM whatsapp_coexistence_onboarding_attempts "+
    "WHERE id=$1 AND waba_id=$2 AND phone_number_id=$3 AND status='validated'",
    [attemptId,wabaId,phoneNumberId]
  );
  const row=attempt.rows?.[0];
  if(!row||digits(row.display_phone_number)!==digits(TARGET))
    throw Error("Verified matching onboarding attempt not found.");
  const credential=await loadCredential({wabaId,phoneNumberId},{database,env});
  const phones=await lookupPhones({
    wabaId,accessToken:credential.accessToken,env,fetchImpl
  });
  const phone=phones.find(x=>x.id===phoneNumberId);
  if(!phone||digits(phone.displayPhoneNumber)!==digits(TARGET))
    throw Error("Meta phone ownership/display does not match approved second number.");
  if(phone.coexistenceReady!==true||phone.isOnBizApp!==true||
     phone.platformType!=="CLOUD_API")
    return {ready:false,updated:false,reason:"Meta Coexistence status not propagated"};
  if(!execute)return {ready:true,updated:false,dryRun:true};
  const saved=await database.query(
    "UPDATE whatsapp_coexistence_onboarding_attempts a "+
    "SET coexistence_ready=TRUE WHERE a.id=$1 AND a.waba_id=$2 "+
    "AND a.phone_number_id=$3 AND a.status='validated' "+
    "AND regexp_replace(a.display_phone_number,'[^0-9]','','g')=$4 "+
    "AND EXISTS (SELECT 1 FROM whatsapp_coexistence_onboarding_credentials c "+
    "WHERE c.attempt_id=a.id AND c.waba_id=$2 AND c.phone_number_id=$3 "+
    "AND c.token_expires_at>NOW()) RETURNING a.id",
    [attemptId,wabaId,phoneNumberId,digits(TARGET)]
  );
  if(saved.rows?.length!==1)
    throw Error("Credential-backed Coexistence status was not updated; inspect sender before retry.");
  return {ready:true,updated:true,attemptId};
}
module.exports={recheck,assertTarget};
