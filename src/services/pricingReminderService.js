const clinicConfig = require("../config/clinicConfig");
const pricingRepo = require("../db/pricingReminderRepo");
const messagesRepo = require("../db/messagesRepo");
const contactsRepo = require("../db/contactsRepo");
const channelMessaging = require("./channelMessagingService");
const realtimeEvents = require("../utils/realtimeEvents");
const { getActivePromotions } = require("../utils/activePromotion");
const { detectConversationLanguage } = require("../utils/chatLanguage");
const { quietHoursStatus, normalizeQuietHours } = require("../utils/quietHours");
const { evaluatePricingReminder } = require("../utils/pricingReminderSelection");
const { MINUTES_AFTER_TESTIMONIAL, FIRST_GRAPHIC_SAFETY_MINUTES, WINDOW_SAFETY_MINUTES } = pricingRepo;

function activationCutoff(settings) {
  const main = Date.parse(settings.activatedAt);
  const pricing = Date.parse(settings.pricingReminder?.activatedAt);
  if (!Number.isFinite(main) || !Number.isFinite(pricing)) return null;
  return new Date(Math.max(main, pricing)).toISOString();
}

function evaluateOffer(candidate, settings = null) {
  const language = detectConversationLanguage(candidate.recent_customer_messages || []);
  return evaluatePricingReminder({
    promotions: getActivePromotions(clinicConfig.promotions || []),
    candidate,
    services: clinicConfig.services || [],
    aliases: clinicConfig.serviceAliases || [],
    language,
    requirePricingInterest: settings?.pricingReminder?.requirePricingInterest !== false,
    sendBothPelvicPackages: settings?.pricingReminder?.sendBothPelvicPackages === true,
  });
}
function chooseOffer(candidate, settings) {
  return evaluateOffer(candidate, settings).offer;
}
function statusForPricingSend(result) {
  if (result?.success) return "sent";
  if (result?.unknown || result?.ambiguous) return "unknown";
  return "failed";
}
// Never move an unsent pricing message ahead of the testimonial. Respect the
// same conservative 10-minute WhatsApp window buffer used by follow-ups.
function canSendAfterFinal(candidate, at = new Date(), imageCount = 1) {
  const thirdAt = Date.parse(candidate?.third_at);
  const inboundAt = Date.parse(candidate?.inbound_at);
  const current = new Date(at).getTime();
  const dueAt = thirdAt + MINUTES_AFTER_TESTIMONIAL * 60_000;
  const safeEnd = inboundAt + (24 * 60 - (imageCount > 1 ? FIRST_GRAPHIC_SAFETY_MINUTES : WINDOW_SAFETY_MINUTES)) * 60_000;
  return [thirdAt, inboundAt, current].every(Number.isFinite)
    && current >= dueAt && current < safeEnd && dueAt < safeEnd;
}
async function skipCandidate(candidate, reason) {
  const recorded = await pricingRepo.recordDecision({ candidate, reason });
  if (!recorded) return;
  if (reason === "delivery_review") {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      "Delivery unconfirmed: pricing graphic was previously attempted. Check its status before resending."
    );
  }
  // A missing package selection is a normal pricing skip, not a human
  // takeover. Keep Follow-up 3 eligible and report the skip in Analytics.
}

function publish(message, reason) {
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id || null,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason,
  });
}

async function sendPricingReminder(candidate, offer, settings, imageCount = 1) {
  if (quietHoursStatus(new Date(), clinicConfig.automatedFollowUp?.quietHours).active ||
      !canSendAfterFinal(candidate, new Date(), imageCount)) return;
  const saved = await pricingRepo.claim({
    candidate,
    offer,
    activatedAt: activationCutoff(settings),
    triggerMode: settings.triggerMode,
  });
  if (!saved) return;

  publish(saved, "message");
  const contact = {
    id: candidate.contact_id,
    channel: "whatsapp",
    whatsapp_number: candidate.whatsapp_number,
  };
  const preSendCheck = async () => {
    const live = clinicConfig.automatedFollowUp;
    if (!live?.enabled || live?.pricingReminder?.enabled !== true ||
        live.activatedAt !== settings.activatedAt ||
        live.pricingReminder?.activatedAt !== settings.pricingReminder.activatedAt ||
        live.triggerMode !== settings.triggerMode ||
        JSON.stringify(normalizeQuietHours(live.quietHours)) !== JSON.stringify(settings.quietHours) ||
        Number(live.additionalSteps?.[1]?.delayMinutes) !== Number(settings.steps[2].delayMinutes) ||
        Number(live.additionalSteps?.[1]?.beforeWindowExpiryMinutes ?? 120) !==
          Number(settings.steps[2].beforeWindowExpiryMinutes) ||
        (live.additionalSteps?.[1]?.timingMode || "after_reply") !==
          settings.steps[2].timingMode ||
        (live.pricingReminder?.requirePricingInterest !== false) !==
          (settings.pricingReminder?.requirePricingInterest !== false) ||
        (live.pricingReminder?.sendBothPelvicPackages === true) !==
          (settings.pricingReminder?.sendBothPelvicPackages === true) ||
        quietHoursStatus(new Date(), live.quietHours).active ||
        !canSendAfterFinal(candidate, new Date(), imageCount)) return false;

    // Changes to a promotion or current interest must not send stale prices.
    const current = chooseOffer(candidate, settings);
    if (!current || current.imageUrl !== offer.imageUrl ||
        current.caption !== offer.caption) return false;
    return pricingRepo.isClaimStillEligible({
      messageId: saved.id,
      contactId: candidate.contact_id,
      anchorId: candidate.anchor_id,
      inboundId: candidate.inbound_id,
      imageIdentities: offer.identities,
      treatmentInterest: candidate.treatment_interest,
      thirdId: candidate.third_id,
      whatsappNumber: candidate.whatsapp_number,
    });
  };

  let result;
  try {
    result = await channelMessaging.sendImageByUrl(
      contact, offer.imageUrl, offer.caption,
      { purpose: "marketing", preSendCheck }
    );
  } catch (err) {
    console.error("Conditional pricing follow-up failed:", err);
    // A thrown provider call can have reached Meta. Do not label it as a
    // definite delivery failure or encourage a blind duplicate retry.
    result = {
      success: false, unknown: true, ambiguous: true,
      error: "Pricing graphic delivery could not be confirmed after an interrupted provider request."
    };
  }
  if (result?.cancelled) {
    if (result.preSendCheckFailed) {
      // The eligibility query failed BEFORE the WhatsApp provider call. This
      // is a cancelled internal verification, never a delivery failure or a
      // "provider may have received it" state.
      const updated = await messagesRepo.setDeliveryStatusById(
        saved.id,
        "cancelled",
        "Internal pricing reminder eligibility check failed; nothing was sent to WhatsApp."
      );
      publish(updated || { ...saved, delivery_status: "cancelled" }, "message_cancelled");
      await contactsRepo.setDeliveryAttention(
        candidate.contact_id,
        "Internal pricing reminder verification failed before sending. Check the automation logs; no WhatsApp pricing graphic was sent."
      );
    } else if (await pricingRepo.discard({
      messageId: saved.id, contactId: candidate.contact_id,
    })) {
      publish({ ...saved, delivery_status: "cancelled" }, "message_cancelled");
    }
    return;
  }

  let updated;
  if (result?.wamid) {
    updated = await messagesRepo.setWhatsappMessageId(saved.id, result.wamid);
  } else {
    updated = await messagesRepo.setDeliveryStatusById(
      saved.id,
      statusForPricingSend(result),
      result?.success ? null : (result?.error || "WhatsApp did not accept the pricing reminder. Review in Inbox.")
    );
  }
  publish(updated || saved, "delivery_status");

  if (!result?.success) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      result?.unknown || result?.ambiguous
        ? "Delivery unconfirmed: pricing graphic may have reached WhatsApp. Check the customer chat before retrying."
        : "Delivery failed: pricing graphic did not reach WhatsApp. Review in Inbox."
    );
  }
  return result?.success ? (updated || saved) : null;
}

async function sendSecondPricing(candidate, first, offer, settings) {
  if (!first || quietHoursStatus(new Date(), clinicConfig.automatedFollowUp?.quietHours).active ||
      !canSendAfterFinal(candidate)) return;
  const saved = await pricingRepo.claimSecond({candidate, firstId:first.id, offer});
  if (!saved) return;
  publish(saved,"message");
  const preSendCheck=async()=>{
    const live=clinicConfig.automatedFollowUp;
    if (!live?.enabled || live.pricingReminder?.enabled!==true ||
        live.activatedAt!==settings.activatedAt ||
        live.pricingReminder?.activatedAt!==settings.pricingReminder?.activatedAt ||
        (live.pricingReminder?.requirePricingInterest!==false)!==
          (settings.pricingReminder?.requirePricingInterest!==false) ||
        (live.pricingReminder?.sendBothPelvicPackages===true)!==
          (settings.pricingReminder?.sendBothPelvicPackages===true) ||
        quietHoursStatus(new Date(),live.quietHours).active ||
        !canSendAfterFinal(candidate)) return false;
    const selected=evaluateOffer(candidate,settings).offers||[];
    if (!selected.some(x=>x.imageUrl===offer.imageUrl && x.caption===offer.caption)) return false;
    return pricingRepo.isSecondStillEligible({messageId:saved.id,firstId:first.id,
      candidate,identities:offer.identities});
  };
  let result;
  try {
    result=await channelMessaging.sendImageByUrl({
      id:candidate.contact_id,channel:"whatsapp",whatsapp_number:candidate.whatsapp_number,
    },offer.imageUrl,offer.caption,{purpose:"marketing",preSendCheck});
  } catch(err) {
    console.error("Second pelvic pricing image interrupted:",err);
    result={success:false,unknown:true,ambiguous:true,
      error:"Second pricing image delivery unconfirmed."};
  }
  if (result?.cancelled) {
    if (result.preSendCheckFailed) {
      const updated=await messagesRepo.setDeliveryStatusById(saved.id,"cancelled",
        "Second pricing image verification failed before provider send.");
      publish(updated||{...saved,delivery_status:"cancelled"},"message_cancelled");
      await contactsRepo.setDeliveryAttention(candidate.contact_id,
        "Second pricing graphic was not sent because its eligibility check failed.");
    } else if (await pricingRepo.discardSecond({
      messageId:saved.id,contactId:candidate.contact_id,firstId:first.id,
    })) {
      publish({...saved,delivery_status:"cancelled"},"message_cancelled");
    }
    return;
  }
  const updated=result?.wamid
    ? await messagesRepo.setWhatsappMessageId(saved.id,result.wamid)
    : await messagesRepo.setDeliveryStatusById(saved.id,statusForPricingSend(result),
      result?.success?null:(result?.error||"Second pricing image failed."));
  publish(updated||saved,"delivery_status");
  if (!result?.success) {
    await contactsRepo.setDeliveryAttention(candidate.contact_id,
      "Second pricing graphic failed or delivery is unconfirmed. Check the chat before retrying.");
  }
}

// Called by the existing follow-up worker so this feature does not add another
// scheduler, timer, or process to each clinic's Render instance.
async function runPricingReminders(settings, now = new Date()) {
  if (settings?.pricingReminder?.enabled !== true ||
      settings.steps.length < 3) return null;

  if (!activationCutoff(settings)) return null;
  const candidates = await pricingRepo.listEligible({
    activatedAt: activationCutoff(settings),
    triggerMode: settings.triggerMode,
  });
  let nextDueAt = null;
  for (const candidate of candidates) {
    try {
      const due = new Date(candidate.due_at).getTime();
      if (!Number.isFinite(due)) continue;
      const { offer, offers = [], reason } = evaluateOffer(candidate,settings);
      // Reserve a larger margin when two images need separate Meta calls.
      const safeEnd = Date.parse(candidate.inbound_at)
        + (24 * 60 - (offers.length > 1 ? FIRST_GRAPHIC_SAFETY_MINUTES : WINDOW_SAFETY_MINUTES)) * 60_000;
      if (!Number.isFinite(safeEnd) || due >= safeEnd || now.getTime() >= safeEnd) {
        await skipCandidate(candidate, "insufficient_window");
        continue;
      }
      if (!offer) {
        if (due <= now.getTime()) await skipCandidate(candidate, reason);
        continue;
      }
      if (due > now.getTime()) {
        if (!nextDueAt || due < new Date(nextDueAt).getTime()) {
          nextDueAt = new Date(due).toISOString();
        }
        continue;
      }
      if (canSendAfterFinal(candidate, now, offers.length)) {
        const first=await sendPricingReminder(candidate,offer,settings,offers.length);
        if (first && offers.length > 1) await sendSecondPricing(candidate,first,offers[1],settings);
      }
    } catch (err) {
      console.error("Pricing reminder candidate failed:", candidate.contact_id, err);
    }
  }
  return nextDueAt;
}
module.exports = { runPricingReminders, sendPricingReminder, chooseOffer, canSendAfterFinal, evaluateOffer, statusForPricingSend };
