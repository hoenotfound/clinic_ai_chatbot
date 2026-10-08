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
const { MINUTES_AFTER_TESTIMONIAL, WINDOW_SAFETY_MINUTES } = pricingRepo;

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
function chooseOffers(candidate, settings = null) {
  return evaluateOffer(candidate, settings).offers || [];
}
function chooseOffer(candidate, settings = null) {
  return chooseOffers(candidate, settings)[0] || null;
}
function statusForPricingSend(result) {
  if (result?.success && (result.wamid || result.externalMessageId)) return "sent";
  // Caption+image are separate Meta calls. A sent caption with a failed image
  // needs human review, not another automatic copy of the caption.
  if (result?.success || result?.partialCaptionSent || result?.unknown || result?.ambiguous) return "unknown";
  return "failed";
}
// Never move an unsent pricing message ahead of the testimonial. Respect the
// same conservative 10-minute WhatsApp window buffer used by follow-ups.
function canSendAfterFinal(candidate, at = new Date(), imageCount = 1) {
  // Recorded immediately after Meta accepted Follow-up 3, not when its
  // placeholder was first saved (video uploads can be slow).
  const thirdAt = Date.parse(candidate?.third_accepted_at);
  const inboundAt = Date.parse(candidate?.inbound_at);
  const current = new Date(at).getTime();
  const dueAt = thirdAt + MINUTES_AFTER_TESTIMONIAL * 60_000;
  const safeEnd = inboundAt + (24 * 60 - (imageCount > 1 ? 15 : WINDOW_SAFETY_MINUTES)) * 60_000;
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
  const channel = candidate.channel || "whatsapp";
  if (!["whatsapp","facebook","instagram"].includes(channel) ||
      (channel !== "whatsapp" && settings.pricingReminder?.enableSocialChannels !== true)) return false;
  if (quietHoursStatus(new Date(), settings.quietHours).active ||
      !canSendAfterFinal(candidate,new Date(),imageCount)) return false;
  const saved = await pricingRepo.claim({
    candidate,
    offer,
    activatedAt: activationCutoff(settings),
    triggerMode: settings.triggerMode,
  });
  if (!saved) return false;

  publish(saved, "message");
  const contact = {
    id: candidate.contact_id,
    channel,
    whatsapp_number: candidate.whatsapp_number,
    channel_user_id: channel_user_id,
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
        (live.pricingReminder?.enableSocialChannels === true) !==
          (settings.pricingReminder?.enableSocialChannels === true) ||
        quietHoursStatus(new Date(), live.quietHours).active ||
        !canSendAfterFinal(candidate,new Date(),imageCount)) return false;

    // Changes to a promotion or current interest must not send stale prices.
    const stillConfigured = chooseOffers(candidate,settings).some((current) =>
      current.packageName === offer.packageName &&
      current.imageUrl === offer.imageUrl && current.caption === offer.caption
    );
    if (!stillConfigured) return false;
    return pricingRepo.isClaimStillEligible({
      messageId: saved.id,
      contactId: candidate.contact_id,
      anchorId: candidate.anchor_id,
      inboundId: candidate.inbound_id,
      imageIdentities: offer.identities,
      treatmentInterest: candidate.treatment_interest,
      thirdId: candidate.third_id,
      recipientId: channel === "whatsapp"
        ? candidate.whatsapp_number : channel_user_id,
      packageKey: offer.packageName,
      channel: channel,
    });
  };

  let result;
  try {
    const providerRecorder = messagesRepo.socialProviderAliasRecorder(saved.id, channel);
    result = await channelMessaging.sendImageByUrl(
      contact, offer.imageUrl, offer.caption,
      { purpose: "marketing", preSendCheck,
        ...(providerRecorder ? { onProviderMessageId: providerRecorder } : {}) }
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
    // preSendCheck runs before any Meta send. A proved unsent claim can be
    // discarded safely even after a transient database verification failure.
    // Re-evaluate on the next sweep rather than permanently suppressing this package.
    const discarded = await pricingRepo.discard({
      messageId: saved.id, contactId: candidate.contact_id,
    });
    if (discarded) {
      publish({ ...saved, delivery_status: "cancelled" }, "message_cancelled");
    }
    if (result.preSendCheckFailed || !discarded) {
      await contactsRepo.setDeliveryAttention(
        candidate.contact_id,
        "Pricing reminder not sent because eligibility could not be verified. Check the automation before retrying."
      );
    }
    return false;
  }

  let updated;
  if (result?.wamid && channel === "whatsapp") {
    updated = await messagesRepo.setWhatsappMessageId(saved.id, result.wamid);
  } else if (result?.success && result?.externalMessageId &&
             ["facebook", "instagram"].includes(channel)) {
    updated = await messagesRepo.setSocialProviderMessageId(
      saved.id, `${channel}:${result.externalMessageId}`, "sent"
    );
  } else {
    updated = await messagesRepo.setDeliveryStatusById(
      saved.id,
      statusForPricingSend(result),
      result?.error || "The channel did not confirm the entire pricing image and caption. Review in Inbox."
    );
  }
  publish(updated || saved, "delivery_status");

  if (!result?.success || statusForPricingSend(result) !== "sent" || !updated) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      statusForPricingSend(result) === "unknown"
        ? "Delivery unconfirmed: pricing graphic or caption may have reached Meta. Check the customer chat before retrying."
        : "Delivery failed: the pricing graphic was rejected. Review in Inbox."
    );
  }
  return Boolean(result?.success &&
    (channel === "whatsapp" ? result.wamid : result.externalMessageId));
}

// Called by the existing follow-up worker so this feature does not add another
// scheduler, timer, or process to each clinic's Render instance.
async function runPricingReminders(settings, now = new Date()) {
  if (settings?.pricingReminder?.enabled !== true ||
      settings.steps.length < 3) return null;

  if (!activationCutoff(settings)) return null;
  let nextDueAt = null;
  let cursor = null;
  // Keyset pagination prevents hundreds of older completed conversations
  // from hiding newer due reminders behind the database batch limit.
  for (let page = 0; page < 10; page += 1) {
    const candidates = await pricingRepo.listEligible({
      activatedAt: activationCutoff(settings),
      triggerMode: settings.triggerMode,
      channels: settings.pricingReminder.enableSocialChannels === true
        ? ["whatsapp","facebook","instagram"] : ["whatsapp"],
      after: cursor,
    });
    if (!candidates.length) break;
    let foundFuture = false;
    for (const candidate of candidates) {
      try {
        const due = new Date(candidate.due_at).getTime();
        if (!Number.isFinite(due)) continue;
        if (due > now.getTime()) {
          if (!nextDueAt || due < new Date(nextDueAt).getTime()) {
            nextDueAt = new Date(due).toISOString();
          }
          // Results are sorted by due_at, so no later row can be due now.
          foundFuture = true;
          break;
        }
        const { offers = [], reason } = evaluateOffer(candidate, settings);
        // Two packages require two separate social or WhatsApp provider sends.
        const safeEnd = Date.parse(candidate.inbound_at)
          + (24 * 60 - (offers.length > 1 ? 15 : WINDOW_SAFETY_MINUTES)) * 60_000;
        if (!Number.isFinite(safeEnd) || due >= safeEnd || now.getTime() >= safeEnd) {
          await skipCandidate(candidate, "insufficient_window");
          continue;
        }
        if (!offers.length) {
          await skipCandidate(candidate, reason);
          continue;
        }
        if (canSendAfterFinal(candidate, now, offers.length)) {
          for (const [index, offer] of offers.entries()) {
            // Distinct provider receipts and one durable claim per package.
            // Stop on partial, unknown, or failed sends for staff review.
            if (!(await sendPricingReminder(candidate, offer, settings,
              index === 0 ? offers.length : 1))) break;
          }
        }
      } catch (err) {
        console.error("Pricing reminder candidate failed:", candidate.contact_id, err);
      }
    }
    if (foundFuture || candidates.length < 200) break;
    const last = candidates[candidates.length - 1];
    cursor = { dueAt: last.due_at, anchorId: last.anchor_id };
    if (page === 9) {
      // A large backlog must not silently stop the adaptive scheduler.
      const soon = new Date(now.getTime() + 30_000).toISOString();
      if (!nextDueAt || new Date(soon) < new Date(nextDueAt)) nextDueAt = soon;
    }
  }
  return nextDueAt;
}
module.exports = { runPricingReminders, sendPricingReminder, chooseOffer, chooseOffers, canSendAfterFinal, evaluateOffer, statusForPricingSend };
