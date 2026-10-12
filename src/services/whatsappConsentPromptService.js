"use strict";

const clinicConfig=require("../config/clinicConfig");
const repo=require("../db/whatsappConsentPromptRepo");
const messagesRepo=require("../db/messagesRepo");
const contactsRepo=require("../db/contactsRepo");
const channelMessaging=require("./channelMessagingService");
const realtimeEvents=require("../utils/realtimeEvents");
const { quietHoursStatus }=require("../utils/quietHours");
const { consentQuestion,consentButtons }=require("../utils/whatsappConsentPrompt");
const { detectConversationLanguage }=require("../utils/chatLanguage");

function businessDisplayName(config=clinicConfig) {
  return String(config.businessName || config.clinicName || "")
    .trim().replace(/\s+(?:Centre|Center)$/i,"");
}
function activationCutoff(settings) {
  const original=Date.parse(settings?.activatedAt);
  const optional=Date.parse(settings?.consentRequest?.activatedAt);
  if (!Number.isFinite(original) || !Number.isFinite(optional)) return null;
  return new Date(Math.max(original,optional)).toISOString();
}
function liveEnabled(settings) {
  const live=clinicConfig.automatedFollowUp;
  return live?.enabled===true && live?.consentRequest?.enabled===true &&
    live.activatedAt===settings.activatedAt &&
    live.consentRequest.activatedAt===settings.consentRequest.activatedAt &&
    live.triggerMode===settings.triggerMode;
}
function pricingCoordination(settings) {
  const pricing=settings?.pricingReminder;
  const active=pricing?.enabled===true &&
    clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled!==true &&
    Number.isFinite(Date.parse(pricing?.activatedAt));
  return { pricingEnabled:active, pricingActivation:active?pricing.activatedAt:null };
}
function publish(message,reason) {
  realtimeEvents.publish("conversation_changed",{
    contactId:message.contact_id,messageId:message.id,reason,
  });
}
async function sendOne(candidate,settings,now=new Date()) {
  if (!liveEnabled(settings) || quietHoursStatus(now,settings.quietHours).active) return false;
  const language=detectConversationLanguage(candidate.recent_customer_messages||[],"zh");
  const question=consentQuestion({
    serviceName:candidate.service_name,businessName:businessDisplayName(),language,
  });
  if (!question) return false;
  const claimed=await repo.claim(candidate,{
    activatedAt:activationCutoff(settings),triggerMode:settings.triggerMode,
    ...pricingCoordination(settings),now,question,
  });
  if (!claimed) return false;
  publish(claimed.message,"message");
  const contact={
    id:claimed.contact_id,channel:"whatsapp",whatsapp_number:claimed.whatsapp_number,
  };
  let result;
  try {
    result=await channelMessaging.sendConsentButtons(
      contact,question,consentButtons(claimed.promptId,language),{
        currentMessageId:claimed.message.id,
        preSendCheck:async()=>liveEnabled(settings) &&
          !quietHoursStatus(new Date(),settings.quietHours).active &&
          repo.stillEligible(claimed,{
            activatedAt:activationCutoff(settings),triggerMode:settings.triggerMode,
            ...pricingCoordination(settings),
          }),
      }
    );
  } catch(err) {
    console.error("Consent prompt provider send interrupted:",err);
    result={success:false,unknown:true,ambiguous:true,
      error:"Consent prompt delivery could not be confirmed."};
  }
  // A result blocked BEFORE the provider was contacted is safe to defer.
  // This includes Strict RM0 billing reservations awaiting reconciliation.
  // Interrupted/ambiguous provider calls are NEVER retried automatically.
  const provablyUnsent = result?.cancelled===true ||
    result?.policyBlocked===true || result?.preSendCheckFailed===true;
  if (provablyUnsent && !result?.partialCaptionSent) {
    try {
      const deferred=await repo.deferUnsent(
        claimed,result?.policyCode||result?.error||"pre_send_cancelled"
      );
      if (!deferred) throw new Error("Could not atomically release an unsent prompt.");
      publish({...claimed.message,delivery_status:"cancelled"},"message_cancelled");
      if (deferred.attempts>=3) {
        await contactsRepo.setDeliveryAttention(claimed.contact_id,
          "Consent request blocked before delivery three times. Staff review required.")
          .catch(()=>{});
      }
      return deferred.retry_after ? new Date(deferred.retry_after).toISOString() : false;
    } catch(err) {
      console.error("Consent request could not be safely deferred:",err);
      await repo.markSent(claimed.promptId,"unknown").catch(()=>{});
      await contactsRepo.setDeliveryAttention(claimed.contact_id,
        "Consent request status is uncertain. Staff must review before retrying.")
        .catch(()=>{});
      return false;
    }
  }
  // A claimed prompt is final on unknown acceptance. Never retry blindly.
  const status=result?.success && result?.wamid ? "accepted" :
    result?.unknown || result?.ambiguous ? "unknown" : "failed";
  try {
    if (status==="accepted") {
      const recorded=await messagesRepo.setWhatsappMessageId(claimed.message.id,result.wamid);
      if (!recorded) throw new Error("Meta accepted the prompt but message ID persistence failed");
      publish(recorded,"delivery_status");
    } else {
      const updated=await messagesRepo.setDeliveryStatusById(
        claimed.message.id,status==="unknown"?"unknown":"failed",
        result?.error || "Consent prompt was not accepted"
      );
      if (updated) publish(updated,"delivery_status");
    }
    await repo.markSent(claimed.promptId,status);
  } catch(err) {
    console.error("Consent prompt receipt persistence failed:",err);
    // The request may have reached Meta. No automatic retry.
    await repo.markSent(claimed.promptId,"unknown").catch(()=>{});
    await contactsRepo.setDeliveryAttention(claimed.contact_id,
      "Consent prompt delivery is unconfirmed. Check the WhatsApp conversation before retrying.")
      .catch(()=>{});
  }
  return status==="accepted";
}

async function runFinalConsentPrompts(settings,now=new Date()) {
  if (settings?.consentRequest?.enabled!==true || settings.steps.length<3 ||
      !activationCutoff(settings)) return null;
  const candidates=await repo.listCandidates({
    activatedAt:activationCutoff(settings),
    triggerMode:settings.triggerMode,...pricingCoordination(settings),now,
  });
  let next=null;
  for (const candidate of candidates) {
    const due=Date.parse(candidate.due_at);
    if (!Number.isFinite(due)) continue;
    if (due>new Date(now).getTime()) {
      if (!next || due<Date.parse(next)) next=new Date(due).toISOString();
      // Database is sorted by due date.
      break;
    }
    try {
      const outcome=await sendOne(candidate,settings,now);
      if (typeof outcome==="string") {
        const retryTime=Date.parse(outcome);
        if (Number.isFinite(retryTime) && (!next || retryTime<Date.parse(next))) next=outcome;
      }
    } catch(err) {
      console.error("Final WhatsApp consent request failed for contact",candidate.contact_id,err);
      const retryAt=new Date(Date.now()+60_000).toISOString();
      if (!next || Date.parse(retryAt)<Date.parse(next)) next=retryAt;
    }
  }
  // Reconstruct the earliest durable retry after Render restarts. A deferred
  // row is hidden from ordinary candidates until its backoff expires.
  const deferredDue=await repo.nextDeferredRetryAt({
    activatedAt:activationCutoff(settings),now,
  });
  if(deferredDue&&(!next||Date.parse(deferredDue)<Date.parse(next))) {
    next=new Date(deferredDue).toISOString();
  }
  // If there is a very large cohort, wake again for a bounded next page.
  if (candidates.length>=200) {
    const soon=new Date(Date.now()+30_000).toISOString();
    if (!next || Date.parse(soon)<Date.parse(next)) next=soon;
  }
  return next;
}
module.exports={
  businessDisplayName,activationCutoff,runFinalConsentPrompts,sendOne,
};
