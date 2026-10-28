"use strict";
// Isolated secondary capture bridge on the Meta app-default webhook.
// Capture is NEVER active without explicit QA flag, exact verified IDs,
// explicit consent, QA sender binding and independent encrypted QA Neon.
// The existing Neutro router runs unchanged when the gate is off.
const capture=require("./whatsappSecondaryQaCapture");
const paid=require("./whatsappPaidDefaultIngress");

function splitSecondaryQaChanges(body,env=process.env){
  if(env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED!=="true")
    return {secondary:null,remaining:body};
  const expected=String(env.WHATSAPP_PAID_SECONDARY_QA_WABA_ID||"");
  const primary=String(env.WHATSAPP_WABA_ID||"");
  if(!/^\d{1,32}$/.test(expected)||expected===primary)
    return {secondary:null,remaining:body};
  if(!body||body.object!=="whatsapp_business_account"||
     !Array.isArray(body.entry)||!body.entry.length||body.entry.length>100)
    throw Error("Malformed app-default WhatsApp batch");
  const secondary=[],remaining=[];
  let seen=0;
  for(const entry of body.entry){
    if(!entry||!Array.isArray(entry.changes)||!entry.changes.length||
       entry.changes.length>100)throw Error("Malformed app-default entry");
    const selected=[],other=[];
    for(const change of entry.changes){
      if(++seen>100)throw Error("Excessive WhatsApp changes");
      if(entry.id===expected&&capture.ALLOWED_FIELDS.has(change?.field))
        selected.push(change);
      else other.push(change);
    }
    if(selected.length)secondary.push({...entry,changes:selected});
    if(other.length)remaining.push({...entry,changes:other});
  }
  return {
    secondary:secondary.length?{...body,entry:secondary}:null,
    remaining:remaining.length?{...body,entry:remaining}:null
  };
}

async function dispatchPaidDefaultWithSecondary(req,res,primaryHandler,{
  env=process.env,
  dispatchPrimary=paid.dispatchDefaultWebhook,
  captureSecondary=capture.captureSignedSecondaryBatch
}={}){
  const {secondary,remaining}=splitSecondaryQaChanges(req.body,env);
  if(!secondary)return dispatchPrimary(req,res,primaryHandler,{env});
  if(!remaining){
    const result=await captureSecondary(secondary,{env,signatureVerified:true});
    if(!result||result.durable!==true)throw Error("Secondary capture not durable");
    return res.sendStatus(200);
  }
  // Always prioritize existing primary Cloud API durability. If a mixed
  // batch contains both accounts, preserve Neutro's ACK and fail safe:
  // a late QA error cannot revoke the already ACKed primary event.
  await dispatchPrimary({...req,body:remaining},res,primaryHandler,{env});
  if(!res.headersSent||res.statusCode!==200)return;
  try{
    const result=await captureSecondary(secondary,{env,signatureVerified:true});
    if(!result||result.durable!==true)throw Error("Secondary capture not durable");
  }catch(error){
    // Do NOT log encrypted content, raw body or Meta tokens.
    console.error("[Secondary QA bridge] Mixed-batch capture failed after primary ACK:",{
      code:error.code||"qa_capture_failed",manualReviewRequired:true
    });
  }
}
module.exports={splitSecondaryQaChanges,dispatchPaidDefaultWithSecondary};
