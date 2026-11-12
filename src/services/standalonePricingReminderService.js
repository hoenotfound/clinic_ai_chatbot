"use strict";
// Optional, independent Neutro pricing reminder. OFF by default.
// The existing 2h/6h/20h and consent/marketing workers are untouched.
const clinicConfig=require("../config/clinicConfig");
const repo=require("../db/standalonePricingReminderRepo");
const contactsRepo=require("../db/contactsRepo");
const messagesRepo=require("../db/messagesRepo");
const channelMessaging=require("./channelMessagingService");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const clinicImage=require("./whatsappSecondaryClinicImage");
const approval=require("./whatsappSecondaryClinicMediaAuthorization");
const {getActivePromotions}=require("../utils/activePromotion");
const {evaluatePricingReminder}=require("../utils/pricingReminderSelection");
const {detectConversationLanguage}=require("../utils/chatLanguage");
const {inferConfiguredServiceFromText}=require("../utils/serviceInterest");
const {hasClinicalMediaRisk}=require("../utils/aiReviewPolicy");
const {quietHoursStatus,normalizeQuietHours}=require("../utils/quietHours");
const realtimeEvents=require("../utils/realtimeEvents");

const PRIMARY="neutro";
const SECONDARY="neutro_secondary";
const MAX_SENDS_PER_WAKE=8;
const SAFE_END_MINUTES=23*60+30;
const DUE_AFTER_HOURS=22;
const FLAG="NEUTRO_STANDALONE_PRICING_REMINDER_ENABLED";
const ACTIVATION="NEUTRO_STANDALONE_PRICING_REMINDER_ACTIVATED_AT";

function settings(env=process.env,config=clinicConfig){
  if(env[FLAG]!=="true" ||
      !/^neutro\s+sense\b/i.test(String(config.businessName||config.clinicName||"")) ||
      !Number.isFinite(Date.parse(env[ACTIVATION])) ||
      config.automatedFollowUp?.enabled!==true ||
      config.automatedFollowUp?.pricingReminder?.enabled===true)return null;
  const senderKeys=[];
  if(env.NEUTRO_STANDALONE_PRICING_PRIMARY_ENABLED==="true")senderKeys.push(PRIMARY);
  if(env.NEUTRO_STANDALONE_PRICING_SECONDARY_ENABLED==="true")senderKeys.push(SECONDARY);
  if(!senderKeys.length)return null;
  return {senderKeys,activatedAt:new Date(env[ACTIVATION]).toISOString(),
    sendBothPelvicPackages:true,requirePricingInterest:false,
    quietHours:normalizeQuietHours(config.automatedFollowUp.quietHours)};
}

// Price is due near closing. If 22h lands in 00:00-07:00 MYT, bring it
// forward to 22:20 MYT the previous evening to avoid the late 20h follow-up.
// Malaysia has no daylight-saving clock changes.
function dueAt(candidate){
  const source=new Date(candidate.source_at).getTime();
  if(!Number.isFinite(source))return null;
  let due=source+DUE_AFTER_HOURS*3600000;
  const localHour=new Date(due+8*3600000).getUTCHours();
  if(localHour<7){
    const local=new Date(due+8*3600000);
    local.setUTCHours(0,0,0,0);
    due=local.getTime()-100*60000-8*3600000;
  }
  // Existing service and opt-in messages always get right of way.
  // Give the customer at least 45 minutes before another automatic offer.
  const last=new Date(candidate.last_automation_at).getTime();
  if(candidate.last_automation_at && Number.isFinite(last))
    due=Math.max(due,last+45*60000);
  return new Date(due);
}
function beforeEnd(candidate,now=new Date()){
  const start=new Date(candidate.source_at).getTime();
  const at=new Date(now).getTime();
  return Number.isFinite(start)&&Number.isFinite(at)&&
    at>=start && at<start+SAFE_END_MINUTES*60000;
}
function select(candidate,options){
  const customerTexts=Array.isArray(candidate.recent_customer_messages)
    ?candidate.recent_customer_messages:[];
  // An old CRM label or unverified ad guess must not authorize unsolicited
  // pricing. Require exactly one service in real, recent customer wording.
  if(!customerTexts.length || customerTexts.some(hasClinicalMediaRisk))
    return {offers:[],reason:"unverified_or_clinical_interest"};
  const named=new Set(customerTexts.map(text=>
    inferConfiguredServiceFromText(String(text||""),{
      services:clinicConfig.services||[],
      serviceAliases:clinicConfig.serviceAliases||[],
    })).filter(Boolean).map(value=>String(value).normalize("NFKC").toLowerCase()));
  if(named.size!==1)return {offers:[],reason:"ambiguous_or_missing_customer_treatment"};
  const language=detectConversationLanguage(customerTexts,"zh");
  const result=evaluatePricingReminder({
    promotions:getActivePromotions(clinicConfig.promotions||[]),
    candidate,services:clinicConfig.services||[],
    aliases:clinicConfig.serviceAliases||[],
    language,
    requirePricingInterest:options.requirePricingInterest,
    sendBothPelvicPackages:options.sendBothPelvicPackages,
  });
  const only=[...named][0];
  return result.offers?.every(offer=>
    String(offer.serviceName||"").normalize("NFKC").toLowerCase()===only)
    ?result:{offers:[],reason:"customer_treatment_changed"};
}
function publish(row){
  if(row?.id)realtimeEvents.publish("conversation_changed",{
    contactId:row.contact_id,messageId:row.id,
    deliveryStatus:row.delivery_status,reason:"delivery_status",
  });
}
async function reportUncertain(candidate,id){
  await contactsRepo.setDeliveryAttention(candidate.contact_id,
    "Scheduled pricing image delivery is unconfirmed. Check WhatsApp before resending.",id)
      .catch(()=>{});
}
async function safeContact(candidate){
  const contact=await contactsRepo.getContactById(candidate.contact_id);
  if(!contact || contact.channel!=="whatsapp" ||
      Number(contact.whatsapp_sender_id)!==Number(candidate.whatsapp_sender_id) ||
      contact.whatsapp_sender_key!==candidate.whatsapp_sender_key ||
      contact.whatsapp_number!==candidate.whatsapp_number || contact.mode!=="ai")
    return null;
  return contact;
}
async function dispatch(candidate,offer,options,row,allOffers){
  const originalRecipient=candidate.whatsapp_number;
  const preSendCheck=async()=>{
    const live=settings();
    if(!live || live.activatedAt!==options.activatedAt ||
       !live.senderKeys.includes(candidate.whatsapp_sender_key) ||
       !beforeEnd(candidate) || quietHoursStatus(new Date(),live.quietHours).active)
      return false;
    const fresh=await safeContact(candidate);
    if(!fresh || fresh.whatsapp_number!==originalRecipient)return false;
    // Preserve the secondary AI media review/approval hold used by normal
    // promotional media. Text permission alone never authorizes images.
    if(candidate.whatsapp_sender_key===SECONDARY &&
       !(await contactsRepo.canSendAutomaticReviewMedia(candidate.contact_id)))
      return false;
    const still=await repo.stillEligible(candidate,row.id,options);
    if(!still)return false;
    const selected=select(candidate,options);
    return selected.offers.length===allOffers.length &&
      selected.offers.some(item=>
        item.packageName===offer.packageName &&
        item.imageUrl===offer.imageUrl && item.caption===offer.caption);
  };
  const contact=await safeContact(candidate);
  if(!contact || !await preSendCheck())return {success:false,cancelled:true};

  if(candidate.whatsapp_sender_key===PRIMARY){
    // The original primary sender/policy path already verifies sender identity,
    // marketing purpose, the service window and the image receipt.
    return channelMessaging.sendImageByUrl(contact,offer.imageUrl,offer.caption,{
      purpose:"marketing",currentMessageId:row.id,preSendCheck
    });
  }
  if(candidate.whatsapp_sender_key!==SECONDARY)return {success:false,cancelled:true};

  // Secondary MUST NOT call channelMessaging's legacy media path. It uses
  // its own sender-bound transport, billing reservations and verified WAMIDs.
  return sendSecondaryStaffText({
    contact,messageId:row.id,text:offer.caption,
    origin:"ai_media",anchorMessageId:candidate.inbound_id,preSendCheck,
    dispatchTransport:async transport=>{
      if(!await preSendCheck())
        return {success:false,unknown:true,ambiguous:true,retryable:false};
      if(clinicImage.storedClinicImageRef(offer.imageUrl)){
        const image=await clinicImage.loadOwnedClinicImage(offer.imageUrl);
        if(!image || !await preSendCheck())
          return {success:false,unknown:true,ambiguous:true,retryable:false};
        const uploaded=await transport.uploadMedia(
          image.buffer,image.mimeType,image.filename);
        if(!uploaded?.success || !/^[0-9]+$/.test(String(uploaded.mediaId||"")))
          return {success:false,unknown:true,ambiguous:true,retryable:false};
        if(!await preSendCheck())
          return {success:false,unknown:true,ambiguous:true,retryable:false};
        return transport.sendMediaById("image",uploaded.mediaId,{caption:offer.caption});
      }
      // External image URLs are accepted only if still present in the
      // clinic's current approved promotion settings.
      if(!approval.isCurrentApprovedClinicImage({
        imageUrl:offer.imageUrl,kind:"promotion",config:clinicConfig
      }))return {success:false,unknown:true,ambiguous:true,retryable:false};
      return transport.sendImageByUrl(offer.imageUrl,offer.caption);
    }
  });
}
async function sendOne(candidate,offer,options,index,allOffers){
  const row=index===0
    ?await repo.claim(candidate,offer)
    :await repo.claimAdditional(candidate,offer);
  if(!row)return false;
  publish(row);
  let result;
  try{result=await dispatch(candidate,offer,options,row,allOffers);}
  catch(error){
    console.warn("[Standalone pricing] Uncertain send; staff review required:",error?.message);
    result={success:false,unknown:true,ambiguous:true};
  }
  const accepted=result?.success===true &&
    result?.unknown!==true && /^wamid\./.test(String(result.wamid||""));
  if(accepted){
    try{
      const saved=await messagesRepo.setWhatsappMessageId(row.id,result.wamid,
        candidate.whatsapp_sender_key===SECONDARY?
          {preserveVerifiedSecondaryReceipt:true}:undefined);
      if(saved){publish(saved);return true;}
    }catch(error){
      console.warn("[Standalone pricing] Accepted but receipt save unconfirmed:",error?.message);
    }
    await reportUncertain(candidate,row.id);
    return false;
  }
  const definiteRejection=result?.definitivelyRejected===true &&
    result?.unknown!==true && result?.ambiguous!==true;
  const definitelyUnsent=result?.cancelled===true &&
    result?.unknown!==true && result?.ambiguous!==true;
  const status=definiteRejection?"failed":definitelyUnsent?"cancelled":"unknown";
  try{
    const saved=await messagesRepo.setDeliveryStatusById(row.id,status,
      status==="unknown"?
        "Pricing image delivery uncertain. Staff must verify before retry.":
        "Pricing send was blocked or rejected.");
    publish(saved);
  }catch{}
  if(status==="unknown")await reportUncertain(candidate,row.id);
  return false;
}
async function runOnce(now=new Date()){
  const options=settings();
  if(!options)return null;
  if(quietHoursStatus(now,options.quietHours).active)return null;
  const candidates=await repo.listCandidates(options);
  let sends=0,nextDue=null;
  for(const candidate of candidates){
    const due=dueAt(candidate);
    if(!due || !beforeEnd(candidate,now))continue;
    if(due.getTime()>new Date(now).getTime()){
      if(!nextDue || due<nextDue)nextDue=due;
      continue;
    }
    if(sends>=MAX_SENDS_PER_WAKE){
      const soon=new Date(new Date(now).getTime()+15000);
      if(!nextDue || soon<nextDue)nextDue=soon;
      break;
    }
    const selected=select(candidate,options);
    if(!selected.offers.length)continue;
    // A/B is a single package set. Never continue after unknown acceptance.
    for(const [index,offer] of selected.offers.entries()){
      if(!beforeEnd(candidate) || !(await sendOne(candidate,offer,options,index,selected.offers)))
        break;
      sends++;
    }
  }
  return nextDue?.toISOString()||null;
}
module.exports={settings,dueAt,beforeEnd,select,runOnce};
