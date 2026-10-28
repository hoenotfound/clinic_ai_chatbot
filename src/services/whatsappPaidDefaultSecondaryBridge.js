"use strict";
// Isolated secondary capture bridge on the Meta app-default webhook.
// Capture is NEVER active without explicit QA flag, exact verified IDs,
// explicit consent, QA sender binding and independent encrypted QA Neon.
// The existing Neutro router runs unchanged when the gate is off.
const capture=require("./whatsappSecondaryQaCapture");
const crypto=require("node:crypto");
const paid=require("./whatsappPaidDefaultIngress");

function splitSecondaryQaChanges(body,env=process.env){
  if(env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED!=="true")
    return {secondary:null,notifications:[],remaining:body};
  const expected=String(env.WHATSAPP_PAID_SECONDARY_QA_WABA_ID||"");
  const primary=String(env.WHATSAPP_WABA_ID||"");
  if(!/^\d{1,32}$/.test(expected)||expected===primary)
    return {secondary:null,notifications:[],remaining:body};
  if(!body||body.object!=="whatsapp_business_account"||
     !Array.isArray(body.entry)||!body.entry.length||body.entry.length>100)
    throw Error("Malformed app-default WhatsApp batch");
  const secondary=[],remaining=[],notifications=[];
  let seen=0;
  for(const entry of body.entry){
    if(!entry||!Array.isArray(entry.changes)||!entry.changes.length||
       entry.changes.length>100)throw Error("Malformed app-default entry");
    const selected=[],other=[];
    for(const change of entry.changes){
      if(++seen>100)throw Error("Excessive WhatsApp changes");
      if(entry.id===expected&&capture.ALLOWED_FIELDS.has(change?.field)) {
        selected.push(change);
      } else if(entry.id===expected&&paid.PASSIVE_META_FIELDS.has(change?.field)) {
        // App-wide notifications may have no phone metadata at all. An
        // explicitly different phone is never accepted as our second number.
        const val=change?.value;
        const pinned=String(env.WHATSAPP_PAID_SECONDARY_QA_PHONE_ID||"");
        const phone=val?.metadata?.phone_number_id??val?.phone_number_id??null;
        const e164=val?.phone_number??null;
        const expectedE164=String(env.WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164||"");
        if(!val||typeof val!=="object"||Array.isArray(val)||
           (phone!==null&&phone!==pinned)||
           (e164!==null&&String(e164).replace(/\D/g,"")!==
             expectedE164.replace(/\D/g,""))) {
          other.push(change);
        } else {
          const timestamp=entry.time??null;
          notifications.push({
            kind:"notification",
            fingerprint:crypto.createHash("sha256").update(JSON.stringify({
              account:entry.id,entryTime:timestamp,change
            })).digest("hex"),
            accountId:entry.id,
            field:change.field,
            phoneId:phone===null?null:pinned
          });
        }
      } else other.push(change);
    }
    if(selected.length)secondary.push({...entry,changes:selected});
    if(other.length)remaining.push({...entry,changes:other});
  }
  return {
    secondary:secondary.length?{...body,entry:secondary}:null,
    notifications,
    remaining:remaining.length?{...body,entry:remaining}:null
  };
}

async function dispatchPaidDefaultWithSecondary(req,res,primaryHandler,{
  env=process.env,
  dispatchPrimary=paid.dispatchDefaultWebhook,
  captureSecondary=capture.captureSignedSecondaryBatch,
  auditSecondary=paid.recordAuditBatch
}={}){
  const {secondary,notifications,remaining}=splitSecondaryQaChanges(req.body,env);
  if(!secondary&&!notifications.length)
    return dispatchPrimary(req,res,primaryHandler,{env});
  const persistQa=async()=>{
    // Test the entire explicit secondary configuration even for account-level
    // fields that don't carry phone metadata.
    const config=capture.captureConfig(env);
    if(secondary){
      const result=await captureSecondary(secondary,{env,signatureVerified:true});
      if(!result||result.durable!==true)throw Error("Secondary capture not durable");
    }
    if(notifications.length){
      const result=await auditSecondary(notifications,config);
      if(!result||result.durable!==true)throw Error("Secondary notification audit not durable");
    }
  };
  if(!remaining){
    await persistQa();
    return res.sendStatus(200);
  }
  // Always prioritize existing primary Cloud API durability. If a mixed
  // batch contains both accounts, preserve Neutro's ACK and fail safe:
  // a late QA error cannot revoke the already ACKed primary event.
  await dispatchPrimary({...req,body:remaining},res,primaryHandler,{env});
  if(!res.headersSent||res.statusCode!==200)return;
  try{
    await persistQa();
  }catch(error){
    // Do NOT log encrypted content, raw body or Meta tokens.
    console.error("[Secondary QA bridge] Mixed-batch capture failed after primary ACK:",{
      code:error.code||"qa_capture_failed",manualReviewRequired:true
    });
  }
}
module.exports={splitSecondaryQaChanges,dispatchPaidDefaultWithSecondary};
