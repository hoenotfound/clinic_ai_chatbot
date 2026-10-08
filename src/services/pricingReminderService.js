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

function activationCutoff(settings) {
  const main = Date.parse(settings.activatedAt);
  const pricing = Date.parse(settings.pricingReminder?.activatedAt);
  if (!Number.isFinite(main) || !Number.isFinite(pricing)) return null;
  return new Date(Math.max(main, pricing)).toISOString();
}

function evaluateOffer(candidate) {
  const language = detectConversationLanguage(candidate.recent_customer_messages || []);
  return evaluatePricingReminder({
    promotions: getActivePromotions(clinicConfig.promotions || []),
    candidate,
    services: clinicConfig.services || [],
    aliases: clinicConfig.serviceAliases || [],
    language,
  });
}
function chooseOffer(candidate) {
  return evaluateOffer(candidate).offer;
}
function statusForPricingSend(result) {
  if (result?.success) return "sent";
  if (result?.unknown || result?.ambiguous) return "unknown";
  return "failed";
}
function canFitBeforeFinal(candidate, at = new Date()) {
  const finalDue = Date.parse(candidate.final_due_at);
  const current = new Date(at).getTime();
  return Number.isFinite(finalDue) && Number.isFinite(current) &&
    current + 120 * 60 * 1000 <= finalDue;
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

async function sendPricingReminder(candidate, offer, settings) {
  if (quietHoursStatus(new Date(), clinicConfig.automatedFollowUp?.quietHours).active) return;
  const saved = await pricingRepo.claim({
    candidate,
    offer,
    activatedAt: activationCutoff(settings),
    triggerMode: settings.triggerMode,
    settings,
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
        quietHoursStatus(new Date(), live.quietHours).active ||
        !canFitBeforeFinal(candidate)) return false;

    // Changes to a promotion or current interest must not send stale prices.
    const current = chooseOffer(candidate);
    if (!current || current.imageUrl !== offer.imageUrl ||
        current.caption !== offer.caption) return false;
    return pricingRepo.isClaimStillEligible({
      messageId: saved.id,
      contactId: candidate.contact_id,
      anchorId: candidate.anchor_id,
      inboundId: candidate.inbound_id,
      imageIdentities: offer.identities,
      treatmentInterest: candidate.treatment_interest,
      finalDueAt: candidate.final_due_at,
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
  if (result?.cancelled && !result?.preSendCheckFailed) {
    if (await pricingRepo.discard({
      messageId: saved.id, contactId: candidate.contact_id,
    })) publish({ ...saved, delivery_status: "cancelled" }, "message_cancelled");
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
    settings,
  });
  let nextDueAt = null;
  for (const candidate of candidates) {
    try {
      const due = new Date(candidate.due_at).getTime();
      if (!Number.isFinite(due)) continue;
      if (!canFitBeforeFinal(candidate, new Date(Math.max(due, now.getTime())))) {
        await skipCandidate(candidate, "insufficient_window");
        continue;
      }
      const { offer, reason } = evaluateOffer(candidate);
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
      await sendPricingReminder(candidate, offer, settings);
    } catch (err) {
      console.error("Pricing reminder candidate failed:", candidate.contact_id, err);
    }
  }
  return nextDueAt;
}
module.exports = { runPricingReminders, chooseOffer, canFitBeforeFinal, evaluateOffer, statusForPricingSend };
