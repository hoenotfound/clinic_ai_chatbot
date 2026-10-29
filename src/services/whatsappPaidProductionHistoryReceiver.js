"use strict";

// OFF by default. This is the production sender-qualified history bridge for
// the already verified second Neutro Business App number, NOT a pre-QR
// anonymous capture path. Never infer a secondary WABA/phone ID from a POST.
const crypto=require("node:crypto");
const history=require("./whatsappCoexistenceHistoryService");
const paid=require("./whatsappPaidDefaultIngress");

const TARGET="+60174831336";
const FIELDS=new Set(["history","smb_app_state_sync"]);
const DISALLOWED=[
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
  "PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED",
  "WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED",
];
function configured(env=process.env){
  return env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED==="true";
}
function assertConfig(env=process.env){
  if(!configured(env))throw Error("Paid production history receiver disabled");
  const id=s=>typeof s==="string" && /^[0-9]{1,32}$/.test(s);
  const primaryPhone=env.WHATSAPP_PHONE_NUMBER_ID;
  const secondaryPhone=env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID;
  const primaryAccount=env.WHATSAPP_WABA_ID;
  const secondaryAccount=env.WHATSAPP_SECONDARY_WABA_ID;
  const secret=env.WHATSAPP_APP_SECRET;
  if(env.PR395_STAGING_MODE==="true" ||
     env.WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED!=="true" ||
     env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED==="true" ||
     env.WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED!=="true" ||
     env.WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED!=="true" ||
     env.WHATSAPP_PRIMARY_SENDER_KEY!=="neutro" ||
     env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
     env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164!==TARGET ||
     env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true" ||
     !history.enabled(env) ||
     env.WHATSAPP_SECONDARY_EXPECTED_WABA_ID!==secondaryAccount ||
     env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID!==secondaryPhone ||
     !id(primaryPhone) || !id(secondaryPhone) ||
     !id(primaryAccount) || !id(secondaryAccount) ||
     primaryPhone===secondaryPhone || primaryAccount===secondaryAccount ||
     typeof secret!=="string" || secret.length<24 ||
     env.META_APP_SECRET!==secret ||
     DISALLOWED.some(k=>env[k]==="true")){
    throw Error("Unverified Neutro second-number history receiver configuration");
  }
  return {primaryAccount,primaryPhone,secondaryAccount,secondaryPhone,secret};
}
function assertSigned(req,secret){
  // The Express parser already enforces Meta raw-body HMAC; verify again at
  // the production-only bridge so test callers cannot bypass the boundary.
  const raw=req.whatsappSignedRawBody;
  const supplied=req.headers?.["x-hub-signature-256"];
  if(!Buffer.isBuffer(raw)||!Buffer.byteLength(raw)||typeof supplied!=="string") {
    throw Error("Missing signed Meta raw-body proof");
  }
  const expected="sha256="+crypto.createHmac("sha256",secret).update(raw).digest("hex");
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) {
    throw Error("Invalid signed Meta raw-body proof");
  }
}
function partition(body,config){
  if(body?.object!=="whatsapp_business_account" ||
     !Array.isArray(body.entry)||!body.entry.length||body.entry.length>100) {
    throw Error("Invalid paid history event batch");
  }
  let total=0,selectedCount=0;
  const selected=[],remaining=[];
  for(const entry of body.entry){
    if(!entry || typeof entry.id!=="string" || !/^[0-9]{1,32}$/.test(entry.id) ||
       !Array.isArray(entry.changes)||!entry.changes.length ||
       entry.changes.length>100)throw Error("Malformed Meta history entry");
    const keep=[],other=[];
    for(const change of entry.changes){
      if(++total>100||!change||typeof change.field!=="string"||
         !change.value||typeof change.value!=="object"||
         Array.isArray(change.value))throw Error("Malformed Meta history change");
      if(entry.id===config.secondaryAccount && FIELDS.has(change.field)){
        if(change.value.metadata?.phone_number_id!==config.secondaryPhone) {
          throw Error("Signed history sender identity mismatch");
        }
        keep.push(change);selectedCount++;
      } else {
        other.push(change);
      }
    }
    if(keep.length)selected.push({...entry,changes:keep});
    if(other.length)remaining.push({...entry,changes:other});
  }
  return {
    selected:selected.length?{object:body.object,entry:selected}:null,
    remaining:remaining.length?{object:body.object,entry:remaining}:null,
    selectedCount
  };
}
// Durably queue exact sender's passive history BEFORE 200. On a mixed batch,
// stage before dispatching the unchanged primary handler. Failure yields 503
// and Meta replay, not an acknowledged-and-lost history event. Deduplication
// lives in the existing durable importer fingerprint UNIQUE constraint.
async function dispatch(req,res,primaryHandler,{
  env=process.env,
  dispatchPrimary=paid.dispatchDefaultWebhook,
  stageHistory=history.acceptPassiveSync,
}={}){
  const config=assertConfig(env);
  assertSigned(req,config.secret);
  if(typeof primaryHandler!=="function")throw Error("Primary handler required");
  const {selected,remaining,selectedCount}=partition(req.body,config);
  if(!selected)return dispatchPrimary(req,res,primaryHandler,{env});
  const result=await stageHistory(selected,{env});
  if(!result || result.enabled!==true || !Number.isSafeInteger(result.staged) ||
     result.staged<0 || result.staged>selectedCount*2000) {
    throw Error("Secondary history could not be durably staged");
  }
  if(remaining){
    return dispatchPrimary({...req,body:remaining},res,primaryHandler,{env});
  }
  return res.sendStatus(200);
}
module.exports={configured,assertConfig,assertSigned,partition,dispatch,TARGET};
