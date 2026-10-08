const clinicConfig = require("../config/clinicConfig");
const pricingRepo = require("../db/pricingReminderRepo");
const messagesRepo = require("../db/messagesRepo");
const contactsRepo = require("../db/contactsRepo");
const channelMessaging = require("./channelMessagingService");
const realtimeEvents = require("../utils/realtimeEvents");
const { getActivePromotions } = require("../utils/activePromotion");
const { detectConversationLanguage } = require("../utils/chatLanguage");
const { quietHoursStatus } = require("../utils/quietHours");
const { selectPricingOffer } = require("../utils/pricingReminderSelection");

function chooseOffer(candidate) {
  const language = detectConversationLanguage(candidate.recent_customer_messages || []);
  return selectPricingOffer({
    promotions: getActivePromotions(clinicConfig.promotions || []),
    candidate,
    services: clinicConfig.services || [],
    aliases: clinicConfig.serviceAliases || [],
    language,
  });
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
  const saved = await pricingRepo.claim({
    candidate,
    offer,
    activatedAt: settings.activatedAt,
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
        live.triggerMode !== settings.triggerMode ||
        quietHoursStatus(new Date(), live.quietHours).active) return false;

    // Changes to a promotion or current interest must not send stale prices.
    const current = chooseOffer(candidate);
    if (!current || current.imageUrl !== offer.imageUrl ||
        current.caption !== offer.caption) return false;
    return pricingRepo.isClaimStillEligible({
      messageId: saved.id,
      contactId: candidate.contact_id,
      anchorId: candidate.anchor_id,
      inboundId: candidate.inbound_id,
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
    result = { success: false };
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
      saved.id, result?.success ? "sent" : "failed",
      result?.success ? null : (result?.error || "WhatsApp did not accept the pricing reminder. Review in Inbox.")
    );
  }
  publish(updated || saved, "delivery_status");

  if (!result?.success) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      "Pricing reminder delivery failed. Please check or retry it from Inbox."
    );
  }
}

// Called by the existing follow-up worker so this feature does not add another
// scheduler, timer, or process to each clinic's Render instance.
async function runPricingReminders(settings, now = new Date()) {
  if (settings?.pricingReminder?.enabled !== true ||
      settings.steps.length < 3) return null;

  const candidates = await pricingRepo.listEligible({
    activatedAt: settings.activatedAt,
    triggerMode: settings.triggerMode,
  });
  let nextDueAt = null;
  for (const candidate of candidates) {
    const offer = chooseOffer(candidate);
    if (!offer) continue;
    const due = new Date(candidate.due_at).getTime();
    if (!Number.isFinite(due)) continue;
    if (due > now.getTime()) {
      if (!nextDueAt || due < new Date(nextDueAt).getTime()) {
        nextDueAt = new Date(due).toISOString();
      }
      continue;
    }
    try {
      await sendPricingReminder(candidate, offer, settings);
    } catch (err) {
      console.error("Pricing reminder candidate failed:", candidate.contact_id, err);
    }
  }
  return nextDueAt;
}
module.exports = { runPricingReminders, chooseOffer };
