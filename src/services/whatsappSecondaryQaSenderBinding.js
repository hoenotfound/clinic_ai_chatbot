"use strict";
// Explicit operator-only QA sender binding AFTER a Meta FINISH event and
// independent Graph ownership confirmation. Not attached to a webhook,
// onboarding callback, startup job, cron, production DB or QR scanner.
const capture=require("./whatsappSecondaryQaCapture");
const ingress=require("./whatsappPaidDefaultIngress");
function validated(binding,env){
  const waba=String(binding?.wabaId||"");
  const phone=String(binding?.phoneNumberId||"");
  const normalized=String(binding?.displayPhoneNumber||"").replace(/[^0-9]/g,"");
  const expected=String(env.WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164||"")
    .replace(/[^0-9]/g,"");
  if(!/^\d{1,32}$/.test(waba)||!/^\d{1,32}$/.test(phone)||
    waba===String(env.WHATSAPP_WABA_ID||"")||
    phone===String(env.WHATSAPP_PHONE_NUMBER_ID||"")||
    !expected||normalized!==expected||
    binding?.finishEvent!=="FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"||
    binding?.graphWabaPhoneOwnershipVerified!==true||
    binding?.isOnBizApp!==true||
    binding?.platformType!=="CLOUD_API"||
    binding?.operatorApproved!==true)
    throw Error("Secondary sender requires independently verified Meta FINISH/ownership and approval");
  return {waba,phone};
}
async function bindQaSender(binding,{env=process.env,database=null}={}){
  const {waba,phone}=validated(binding,env);
  const config=capture.captureConfig(env);
  if(config.waba!==waba||config.phoneId!==phone)
    throw Error("Verified secondary IDs do not match pinned QA capture configuration");
  const pool=database||ingress.getQaPool(config);
  const client=await pool.connect();
  let began=false;
  try{
    await client.query("BEGIN");began=true;
    const versions=await client.query(
      "SELECT version,name FROM schema_migrations WHERE version IN (102,103,104)"
    );
    if(versions.rows?.length!==3||
      versions.rows.find(r=>Number(r.version)===104)?.name!==
        "whatsapp_coexistence_once_only_and_lifecycle_alerts")
      throw Error("Wrong isolated QA migration history");
    const existing=await client.query(
      "SELECT sender_key,meta_account_id,meta_phone_number_id,state," +
      "coexistence_enabled FROM whatsapp_sender_accounts FOR UPDATE"
    );
    // Never modify or mix another business number, even in isolated QA.
    if(existing.rows.some(s=>s.sender_key!=="coexistence_qa"||
      s.meta_account_id!==waba||s.meta_phone_number_id!==phone))
      throw Error("QA already contains a different sender; manual review required");
    const result=await client.query(
      "INSERT INTO whatsapp_sender_accounts" +
      "(sender_key,meta_account_id,meta_phone_number_id,display_name,state,coexistence_enabled) " +
      "VALUES('coexistence_qa',$1,$2,'Verified QA secondary','testing',TRUE) " +
      "ON CONFLICT(sender_key) DO UPDATE SET updated_at=NOW() " +
      "WHERE whatsapp_sender_accounts.meta_account_id=EXCLUDED.meta_account_id " +
      "AND whatsapp_sender_accounts.meta_phone_number_id=EXCLUDED.meta_phone_number_id " +
      "AND whatsapp_sender_accounts.state='testing' " +
      "RETURNING id,sender_key,state",
      [waba,phone]
    );
    if(result.rows?.length!==1)throw Error("QA sender could not be safely bound");
    await client.query("COMMIT");began=false;
    return {qaOnly:true,bound:true,senderState:"testing"};
  }catch(error){if(began)await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}
module.exports={validated,bindQaSender};
