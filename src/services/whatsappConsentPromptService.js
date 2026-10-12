"use strict";

const clinicConfig=require("../config/clinicConfig");
const repo=require("../db/whatsappConsentPromptRepo");
const messagesRepo=require("../db/messagesRepo");
const contactsRepo=require("../db/contactsRepo");
const channelMessaging=require("./channelMessagingService");
const realtimeEvents=require("../utils/realtimeEvents");
const { quietHoursStatus }=require("../utils/quietHours");
const { consentQuestion,consentButtons }=require("../utils/whatsappConsentPrompt");

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
function publish(message,reason) {
  realtimeEvents.publish("conversation_changed",{
    contactId:message.contact_id,messageId:message.id,reason,
  });
}
async function sendOne(candidate,settings,now=new Date()) {
  if (!liveEnabled(settings) || quietHoursStatus(now,settings.quietHours).active) return false;
  const question=consentQuestion({
    serviceName:candidate.service_name,businessName:businessDisplayName(),
  });
  if (!question) return false;
  const claimed=await repo.claim(candidate,{
    activatedAt:activationCutoff(settings),triggerMode:settings.triggerMode,now,question,
  });
  if (!claimed) return false;
  publish(claimed.message,"message");
  const contact={
    id:claimed.contact_id,channel:"whatsapp",whatsapp_number:claimed.whatsapp_number,
  };
  let result;
  try {
    result=await channelMessaging.sendConsentButtons(
      contact,question,consentButtons(claimed.promptId),{
        currentMessageId:claimed.message.id,
        preSendCheck:async()=>liveEnabled(settings) &&
          !quietHoursStatus(new Date(),settings.quietHours).active &&
          repo.stillEligible(claimed,{
            activatedAt:activationCutoff(settings),triggerMode:settings.triggerMode,
          }),
      }
    );
  } catch(err) {
    console.error("Consent prompt provider send interrupted:",err);
    result={success:false,unknown:true,ambiguous:true,
      error:"Consent prompt delivery could not be confirmed."};
  }
  // A claimed prompt is final. Unknown acceptance must never be retried blindly.
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
    triggerMode:settings.triggerMode,now,
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
      await sendOne(candidate,settings,now);
    } catch(err) {
      console.error("Final WhatsApp consent request failed for contact",candidate.contact_id,err);
      const retryAt=new Date(Date.now()+60_000).toISOString();
      if (!next || Date.parse(retryAt)<Date.parse(next)) next=retryAt;
    }
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
