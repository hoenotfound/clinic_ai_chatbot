"use strict";

// OFF by default. This is the production sender-qualified history bridge for
// the already verified second Neutro Business App number, NOT a pre-QR
// anonymous capture path. Never infer a secondary WABA/phone ID from a POST.
const crypto=require("node:crypto");
const history=require("./whatsappCoexistenceHistoryService");
const paid=require("./whatsappPaidDefaultIngress");

const TARGET="+60174831336";
const FIELDS=new Set(["history","smb_app_state_sync"]);
// Only receiver-specific events are forwarded to the existing signed /webhook
// handler, which already enforces sender-scoped conversation and AI boundaries.
const LIVE_FIELDS=new Set(["messages","smb_message_echoes","account_update"]);
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
// The live Inbox bridge is independent of owner consent to export old chats.
// A client may receive new messages while keeping history sync disabled.
function liveConfigured(env=process.env){
  return env.WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED==="true";
}
function assertLiveConfig(env=process.env){
  if(!liveConfigured(env))throw Error("Paid secondary live receiver disabled");
  const primaryAccount=env.WHATSAPP_WABA_ID;
  const primaryPhone=env.WHATSAPP_PHONE_NUMBER_ID;
  const secondaryAccount=env.WHATSAPP_SECONDARY_WABA_ID;
  const secondaryPhone=env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID;
  const secret=env.WHATSAPP_APP_SECRET;
  const id=x=>typeof x==="string" && /^[0-9]{1,32}$/.test(x);
  if(env.PR395_STAGING_MODE==="true" ||
     env.WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED!=="true" ||
     env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED==="true" ||
     env.WHATSAPP_MULTI_NUMBER_READ_ENABLED!=="true" ||
     env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED!=="true" ||
     env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true" ||
     env.WHATSAPP_SINGLE_SENDER_STRICT_METADATA!=="true" ||
     env.WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED!=="true" ||
     env.WHATSAPP_PRIMARY_SENDER_KEY!=="neutro" ||
     env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
     env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164!==TARGET ||
     env.WHATSAPP_SECONDARY_EXPECTED_WABA_ID!==secondaryAccount ||
     env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID!==secondaryPhone ||
     !id(primaryPhone)||!id(primaryAccount)||!id(secondaryPhone)||!id(secondaryAccount) ||
     primaryPhone===secondaryPhone || primaryAccount===secondaryAccount ||
     typeof secret!=="string" || secret.length<24 ||
     env.META_APP_SECRET!==secret ||
     DISALLOWED.some(k=>env[k]==="true"))
    throw Error("Unverified Neutro second-number live receiver configuration");
  return {primaryAccount,primaryPhone,secondaryAccount,secondaryPhone,secret};
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
  const selected=[],live=[],remaining=[];
  for(const entry of body.entry){
    if(!entry || typeof entry.id!=="string" || !/^[0-9]{1,32}$/.test(entry.id) ||
       !Array.isArray(entry.changes)||!entry.changes.length ||
       entry.changes.length>100)throw Error("Malformed Meta history entry");
    const keep=[],forward=[],other=[];
    for(const change of entry.changes){
      if(++total>100||!change||typeof change.field!=="string"||
         !change.value||typeof change.value!=="object"||
         Array.isArray(change.value))throw Error("Malformed Meta history change");
      if(entry.id===config.secondaryAccount && FIELDS.has(change.field)){
        if(change.value.metadata?.phone_number_id!==config.secondaryPhone)
          throw Error("Signed history sender identity mismatch");
        keep.push(change);selectedCount++;
      } else if(entry.id===config.secondaryAccount && LIVE_FIELDS.has(change.field)){
        if(change.field==="account_update"){
          // Lifecycle notifications sometimes have no phone ID. Require the
          // independently verified E164 before forwarding a disconnect.
          const e164=change.value.phone_number;
          if(typeof e164!=="string" ||
             e164.replace(/\D/g,"")!==TARGET.replace(/\D/g,""))
            throw Error("Signed live sender identity mismatch");
        } else if(change.value.metadata?.phone_number_id!==config.secondaryPhone){
          throw Error("Signed live sender identity mismatch");
        }
        forward.push(change);
      } else other.push(change);
    }
    if(keep.length)selected.push({...entry,changes:keep});
    if(forward.length)live.push({...entry,changes:forward});
    if(other.length)remaining.push({...entry,changes:other});
  }
  return {
    selected:selected.length?{object:body.object,entry:selected}:null,
    live:live.length?{object:body.object,entry:live}:null,
    remaining:remaining.length?{object:body.object,entry:remaining}:null,
    selectedCount
  };
}
function assertSafeLiveRemainder(remaining,config){
  // A mixed callback may contain primary and secondary messages. The regular
  // webhook can handle both. Do not bypass the default router's audit policy
  // for foreign WABAs or unrelated passive notifications.
  for(const entry of remaining?.entry||[]){
    if(entry.id!==config.primaryAccount || entry.changes.some(change=>
      !["messages","smb_message_echoes"].includes(change.field) ||
      change.value?.metadata?.phone_number_id!==config.primaryPhone)) {
      throw Error("Unsafe mixed WhatsApp live batch; no partial ACK");
    }
  }
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
  const historyMode=configured(env);
  const config=historyMode?assertConfig(env):assertLiveConfig(env);
  assertSigned(req,config.secret);
  if(typeof primaryHandler!=="function")throw Error("Primary handler required");
  const {selected,live,remaining,selectedCount}=partition(req.body,config);
  // Reject unsafe mixed batches before staging or acknowledging any change.
  if(live)assertSafeLiveRemainder(remaining,config);
  // History consent and import flags are separate from permission to receive
  // NEW messages. Never acknowledge or drop an old-history event in live-only.
  if(selected&&!historyMode)throw Error("Secondary history receiver not approved");
  if(selected){
    const result=await stageHistory(selected,{env});
    if(!result || result.enabled!==true || !Number.isSafeInteger(result.staged) ||
       result.staged<0 || result.staged>selectedCount*2000) {
      throw Error("Secondary history could not be durably staged");
    }
  }
  if(live){
    // The same verified primary /webhook function already handles distinct
    // sender IDs, staff echoes and secondary no-AI Inbox-only behavior.
    // Preserve the signed original req; never issue an outbound send here.
    const entries=[...(remaining?.entry||[]),...live.entry];
    return primaryHandler({...req,body:{object:req.body.object,entry:entries}},res);
  }
  if(remaining)return dispatchPrimary({...req,body:remaining},res,primaryHandler,{env});
  return res.sendStatus(200);
}
module.exports={configured,liveConfigured,assertLiveConfig,assertConfig,assertSigned,partition,dispatch,TARGET};
