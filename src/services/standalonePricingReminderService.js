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
const {imageReview}=require("../utils/standalonePricingManualMedia");
const {detectConversationLanguage}=require("../utils/chatLanguage");
const {inferConfiguredServiceFromText,normalizeServiceText}=require("../utils/serviceInterest");
const {hasClinicalMediaRisk}=require("../utils/aiReviewPolicy");
const {quietHoursStatus,normalizeQuietHours}=require("../utils/quietHours");
const realtimeEvents=require("../utils/realtimeEvents");

const PRIMARY="neutro";
const SECONDARY="neutro_secondary";
const MAX_SENDS_PER_WAKE=2;
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
  const quietHours=normalizeQuietHours(config.automatedFollowUp.quietHours);
  if(!quietHours)return null;
  return {senderKeys,activatedAt:new Date(env[ACTIVATION]).toISOString(),
    sendBothPelvicPackages:true,requirePricingInterest:false,quietHours};
}

// A pricing graphic is the last service-window message, not an early offer.
// A non-quiet due time is 22 hours after the last inbound. When that time
// lands in 00:00-07:00 MYT, the previous evening can be used ONLY if the
// customer message is at least 20 hours old. Otherwise skip rather than send
// an aggressive offer 14-17 hours into the conversation.
function dueAt(candidate,quietHours=normalizeQuietHours()){
  const source=Date.parse(candidate.source_at);
  if(!Number.isFinite(source))return null;
  let due=source+DUE_AFTER_HOURS*3600000;
  if(quietHoursStatus(new Date(due),quietHours).active){
    if(!quietHours.enabled || quietHours.start!=="00:00" || quietHours.end!=="07:00")
      return null;
    const local=new Date(due+8*3600000);
    local.setUTCHours(0,0,0,0);
    due=local.getTime()-40*60000-8*3600000; // 23:20 MYT
    if(due<source+20*3600000)return null;
  }
  const last=candidate.last_automation_at?Date.parse(candidate.last_automation_at):NaN;
  if(Number.isFinite(last))due=Math.max(due,last+45*60000);
  if(due>source+SAFE_END_MINUTES*60000 ||
      quietHoursStatus(new Date(due),quietHours).active)return null;
  return new Date(due);
}
function beforeEnd(candidate,now=new Date()){
  const start=new Date(candidate.source_at).getTime();
  const at=new Date(now).getTime();
  return Number.isFinite(start)&&Number.isFinite(at)&&
    at>=start && at<start+SAFE_END_MINUTES*60000;
}
// Resolve a vague reply to a single, supported treatment. Strongest evidence
// is the customer's own recent wording, then a recent authenticated ad on
// the exact sender, then recent provider-verified consent for the current
// treatment. Never guess a treatment from a stale lead label alone.
function resolveRecentPricingTreatment(candidate,customerTexts,config=clinicConfig){
  const services=config.services||[];
  const aliases=config.serviceAliases||[];
  const lead=normalizeServiceText(candidate.treatment_interest);
  const named=new Set(customerTexts.map(text=>
    inferConfiguredServiceFromText(String(text||""),{
      services,serviceAliases:aliases,
    })).filter(Boolean).map(normalizeServiceText));
  if(named.size>1)return {service:null,reason:"conflicting_customer_treatments"};

  // A comparison such as "3D or 9D?" must not become a guessed price even
  // when our generic service parser correctly returns no single service.
  const simple=services.filter(service=>!String(service.name||"").includes("+"));
  const individualMentions=new Set();
  for(const text of customerTexts){
    for(const service of simple){
      const matched=inferConfiguredServiceFromText(String(text||""),{
        services:[service],serviceAliases:aliases,
      });
      if(matched)individualMentions.add(normalizeServiceText(matched));
    }
  }
  if(individualMentions.size>1 && (
    named.size===0 || ![...named][0].includes("+")))
    return {service:null,reason:"ambiguous_comparison"};

  let chosen=named.size===1?[...named][0]:null;
  if(!chosen){
    const fromAd=new Set([
      candidate.ad_treatment_interest,
      inferConfiguredServiceFromText(candidate.ad_name,{services,serviceAliases:aliases}),
    ].filter(Boolean).map(normalizeServiceText));
    if(fromAd.size>1)return {service:null,reason:"conflicting_ad_treatment"};
    if(fromAd.size===1)chosen=[...fromAd][0];
    else if(candidate.recent_verified_treatment_consent===true)chosen=lead;
  }
  if(!chosen)return {service:null,reason:"ambiguous_or_missing_customer_treatment"};
  if(!lead || chosen!==lead)
    return {service:null,reason:"consent_treatment_mismatch"};
  return {service:chosen,reason:null};
}
function select(candidate,options){
  const customerTexts=Array.isArray(candidate.recent_customer_messages)
    ?candidate.recent_customer_messages:[];
  // A declined offer anywhere in this service session overrides older
  // treatment labels, even if the latest inbound was only "Hi".
  if(customerTexts.some(text=>
      /(不要了|不需要|没兴趣|沒興趣|停止优惠|停止優惠|停止跟进|停止跟進|not interested|no thanks|stop promotions|unsubscribe|tak berminat)/iu
        .test(String(text||""))))
    return {offers:[],reason:"customer_declined"};
  // An old CRM label or unverified ad guess must not authorize unsolicited
  // pricing. Require exactly one service in real, recent customer wording.
  if(!customerTexts.length || customerTexts.some(hasClinicalMediaRisk))
    return {offers:[],reason:"unverified_or_clinical_interest"};
  const matched=resolveRecentPricingTreatment(candidate,customerTexts);
  if(!matched.service)return {offers:[],reason:matched.reason};
  const language=detectConversationLanguage(customerTexts,"zh");
  const result=evaluatePricingReminder({
    promotions:getActivePromotions(clinicConfig.promotions||[]),
    candidate:{...candidate,
      // A staff-sent image may have no caption. Preserve it when checking
      // all language variants and uncertain delivery statuses.
      sent_media:(candidate.sent_media||[]).map(m=>({
        ...m,content:m.content||"[image]"
      }))},
    services:clinicConfig.services||[],
    aliases:clinicConfig.serviceAliases||[],
    language,
    requirePricingInterest:options.requirePricingInterest,
    sendBothPelvicPackages:options.sendBothPelvicPackages,
  });
  const only=matched.service;
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
// Alerts are created once per contact/window/reason, not every scheduler wake.
// Preserve higher-priority staff/clinical Inbox alerts through contactsRepo.
async function staffReview(candidate,reason){
  const inserted=await repo.recordDecision(candidate,"review:"+reason);
  if(inserted)await contactsRepo.setDeliveryAttention(candidate.contact_id,
    "Pricing reminder needs staff review: a manual image or uncertain delivery may already contain the price. Check this chat before sending any graphic.").catch(error=>
      console.warn("[Standalone pricing] Could not surface Inbox review:",error?.message));
}
async function classifyStaffImages(candidate,offers){
  const images=await repo.listRecentStaffImages(candidate);
  return imageReview(offers,images,{inboundAt:candidate.inbound_at});
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
    const still=await repo.stillEligible(candidate,row.id,options,offer);
    if(!still)return false;
    const selected=select(candidate,options);
    // Staff may have just sent the graphic from the WhatsApp Business App,
    // using a different R2 key. Recheck immediately before the Meta call.
    const manual=await classifyStaffImages(candidate,allOffers);
    if(manual.action!=="clear"){
      if(manual.action==="review")await staffReview(candidate,manual.reason);
      else await repo.recordDecision(candidate,"skipped:"+manual.reason);
      return false;
    }
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
async function sendOne(candidate,offer,options,allOffers){
  // Reuse only a provably unsent queued claim. For a fresh request, claim the
  // first image; Package B is a separate claim after A's verified acceptance.
  const row=await repo.resumeDeferred(candidate,offer)
    || await repo.claim(candidate,offer)
    || await repo.claimAdditional(candidate,offer);
  if(!row)return {sent:false,waiting:true};
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
      if(saved){
        publish(saved);
        await repo.recordDecision(candidate,"provider_accepted:"+offer.packageName).catch(()=>{});
        return {sent:true};
      }
    }catch(error){
      console.warn("[Standalone pricing] Accepted but receipt save unconfirmed:",error?.message);
    }
    await repo.recordDecision(candidate,"provider_accepted_local_receipt_unconfirmed").catch(()=>{});
    await reportUncertain(candidate,row.id);
    return {sent:false,review:true};
  }
  // Only a confirmed PRE-provider block can be retried; a sender billing
  // reservation, ambiguous HTTP response or WAMID is never reset.
  const safelyBlocked=result?.unknown!==true && result?.ambiguous!==true &&
    !result?.wamid && (result?.policyBlocked===true || result?.cancelled===true);
  if(safelyBlocked){
    const deferred=await repo.deferUnsent(candidate,row,result.code||"preflight");
    if(deferred){
      publish(deferred.row);
      const retry=deferred.retry;
      await repo.recordDecision(candidate,"deferred:"+String(result.code||"preflight")).catch(()=>{});
      if(retry && Number(retry.attempts)>=3){
        await repo.recordDecision(candidate,"preflight_exhausted:"+offer.packageName).catch(()=>{});
        return {sent:false,review:true};
      }
      return {sent:false,nextAt:retry?.retry_after||null};
    }
  }
  const rejected=result?.definitivelyRejected===true &&
    result?.unknown!==true && result?.ambiguous!==true;
  const status=rejected?"failed":"unknown";
  try{
    const saved=await messagesRepo.setDeliveryStatusById(row.id,status,
      rejected?"Pricing image rejected by Meta. Manual review required."
        :"Pricing image delivery uncertain. Check sender receipt; do not retry blindly.");
    publish(saved);
  }catch{}
  await repo.recordDecision(candidate,status+":"+offer.packageName).catch(()=>{});
  // A definite rejection should not trigger the identical image again; an
  // unknown outcome must be surfaced and block any subsequent package.
  await reportUncertain(candidate,row.id);
  return {sent:false,review:true};
}
async function runOnce(now=new Date()){
  const options=settings();
  if(!options)return null;
  if(quietHoursStatus(now,options.quietHours).active)return null;
  const candidates=await repo.listCandidates(options);
  let sends=0,nextDue=null;
  const soon=(delayMs=90000)=>new Date(new Date(now).getTime()+delayMs);
  const track=(timestamp)=>{
    if(!timestamp || !Number.isFinite(Date.parse(timestamp)))return;
    const date=new Date(timestamp);
    if(!nextDue || date<nextDue)nextDue=date;
  };
  for(const candidate of candidates){
    const due=dueAt(candidate,options.quietHours);
    if(!due){
      await repo.recordDecision(candidate,"quiet_hours_no_safe_window").catch(()=>{});
      continue;
    }
    if(!beforeEnd(candidate,now))continue;
    if(due.getTime()>new Date(now).getTime()){
      track(due.toISOString());
      continue;
    }
    if(sends>=MAX_SENDS_PER_WAKE){track(soon().toISOString());break;}
    const selected=select(candidate,options);
    if(!selected.offers?.length){
      if(selected.reason==="delivery_review")await staffReview(candidate,"prior_image_delivery_unverified");
      else await repo.recordDecision(candidate,"skipped:"+String(selected.reason||"no_offer")).catch(()=>{});
      continue;
    }
    // Do not claim a new send while staff's image could already contain the
    // price. A caption match confirms a duplicate; captionless/unclear media
    // goes to Inbox review rather than being resent automatically.
    const manual=await classifyStaffImages(candidate,selected.offers);
    if(manual.action!=="clear"){
      if(manual.action==="review")await staffReview(candidate,manual.reason);
      else await repo.recordDecision(candidate,"skipped:"+manual.reason);
      continue;
    }
    // The selected package set is fixed for this pass, but final rechecks
    // still verify current promotions, recipient and follow-up state.
    let sentForCandidate=0;
    for(const offer of selected.offers){
      if(!beforeEnd(candidate))break;
      const result=await sendOne(candidate,offer,options,selected.offers);
      if(result.sent){sends++;sentForCandidate++;continue;}
      if(result.nextAt)track(result.nextAt);
      if(result.waiting &&
         (candidate.has_accepted_package_a || candidate.next_preflight_retry_at)){
        const retry=Date.parse(candidate.next_preflight_retry_at||"");
        track(Number.isFinite(retry)&&retry>new Date(now).getTime()
          ?new Date(retry).toISOString():soon().toISOString());
      }
      if(result.review)await repo.recordDecision(candidate,"staff_review:"+offer.packageName).catch(()=>{});
      break;
    }
    // After accepting A on secondary, B cannot be sent until the signed Meta
    // receipt has released the sender-specific billing gate. Wake again later.
    if(candidate.whatsapp_sender_key===SECONDARY && selected.offers.length>1 &&
       sentForCandidate>0)track(soon().toISOString());
  }
  return nextDue?.toISOString()||null;
}
module.exports={settings,dueAt,beforeEnd,resolveRecentPricingTreatment,select,runOnce};
