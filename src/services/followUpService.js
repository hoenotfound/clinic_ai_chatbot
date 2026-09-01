const clinicConfig = require("../config/clinicConfig");
const messagesRepo = require("../db/messagesRepo");
const followUpRepo = require("../db/followUpRepo");
const contactsRepo = require("../db/contactsRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { detectConversationLanguage } = require("../utils/chatLanguage");
const channelMessaging = require("./channelMessagingService");

const FOLLOW_UP_CHECK_INTERVAL_MS = 60 * 1000;
const FOLLOW_UP_BATCH_SIZE = 25;
const STALE_CLAIM_GRACE_MINUTES = 10;

let sweepRunning = false;

function getActiveSettings() {
  const settings = clinicConfig.automatedFollowUp;
  if (
    !settings?.enabled ||
    !Number.isInteger(settings.delayMinutes) ||
    settings.delayMinutes < 5 ||
    settings.delayMinutes > 23 * 60 ||
    !["all", "staff"].includes(settings.triggerMode) ||
    typeof settings.message !== "string" ||
    !settings.message.trim() ||
    (settings.translations !== undefined &&
      (typeof settings.translations !== "object" || settings.translations === null)) ||
    (settings.imageUrl !== undefined && typeof settings.imageUrl !== "string") ||
    typeof settings.activatedAt !== "string" ||
    Number.isNaN(Date.parse(settings.activatedAt))
  ) {
    return null;
  }

  return {
    delayMinutes: settings.delayMinutes,
    triggerMode: settings.triggerMode,
    message: settings.message.trim(),
    translations: Object.fromEntries(
      ["en", "ms", "zh"].map((key) => [
        key,
        typeof settings.translations?.[key] === "string" &&
        settings.translations[key].trim()
          ? settings.translations[key].trim()
          : settings.message.trim(),
      ])
    ),
    imageUrl: settings.imageUrl?.trim() || "",
    activatedAt: settings.activatedAt,
  };
}

function publishConversationChange(message, reason) {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason,
  });
}

function contactForCandidate(candidate) {
  return {
    channel: candidate.channel || "whatsapp",
    whatsapp_number: candidate.whatsapp_number,
    channel_user_id: candidate.channel_user_id,
  };
}

function rejectedFollowUpError(channel) {
  return `${channelMessaging.labelForChannel(channel)} did not accept this automated follow-up. Check the reply window or connection and retry it from the Inbox.`;
}

async function sendCandidate(candidate) {
  // Read the live settings again for every candidate. A staff member may
  // pause the tool or make its criteria stricter while a sweep is running.
  const settings = getActiveSettings();
  if (!settings) return;

  const language = detectConversationLanguage([
    ...(candidate.recent_inbound_messages || []),
    candidate.trigger_message_content,
  ]);
  const followUpMessage = settings.translations[language] || settings.message;

  const saved = await followUpRepo.saveIfStillEligible({
    contactId: candidate.contact_id,
    triggerMessageId: candidate.trigger_message_id,
    content: followUpMessage,
    mediaUrl: settings.imageUrl || null,
    delayMinutes: settings.delayMinutes,
    triggerMode: settings.triggerMode,
    activatedAt: settings.activatedAt,
  });

  // The customer may have replied since the candidate query, or another
  // server instance may already have claimed this exact trigger.
  if (!saved) return;

  publishConversationChange(saved, "message");

  const contact = contactForCandidate(candidate);
  const channel = contact.channel || "whatsapp";
  const rejectedError = rejectedFollowUpError(channel);

  let sendResult;
  try {
    sendResult = settings.imageUrl
      ? await channelMessaging.sendImageByUrl(
          contact,
          settings.imageUrl,
          followUpMessage
        )
      : await channelMessaging.sendText(contact, followUpMessage);
  } catch (err) {
    console.error("Automated follow-up send failed:", err);
    sendResult = { success: false, wamid: null, externalMessageId: null };
  }

  let finalMessage = saved;
  if (sendResult?.wamid) {
    // WhatsApp keeps using its asynchronous WAMID delivery-status pipeline.
    finalMessage =
      (await messagesRepo.setWhatsappMessageId(saved.id, sendResult.wamid)) || saved;
  } else if (!sendResult?.success) {
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(
        saved.id,
        "failed",
        rejectedError
      )) || saved;
  } else if (channel !== "whatsapp") {
    // Messenger/Instagram return an accepted send result but do not use the
    // WhatsApp WAMID webhook pipeline. Mark that accepted result immediately
    // so crash recovery can distinguish it from a claim whose send outcome
    // was never recorded.
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(saved.id, "sent", null)) || saved;
  }

  publishConversationChange(finalMessage, "delivery_status");

  if (!sendResult?.success) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      `Delivery failed: ${rejectedError}`
    );
  } else {
    try {
      await pipelineRepo.markContactedForContact(
        candidate.contact_id,
        "Automated follow-up"
      );
    } catch (err) {
      console.error(
        `Failed to mark lead ${candidate.contact_id} as contacted after automated follow-up:`,
        err
      );
    }
  }
}

async function recoverInterruptedFollowUps() {
  const recovered = await followUpRepo.markStaleClaimsUnconfirmed({
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
    limit: FOLLOW_UP_BATCH_SIZE,
  });

  for (const message of recovered) {
    publishConversationChange(message, "delivery_status");
    try {
      await contactsRepo.setDeliveryAttention(
        message.contact_id,
        `Delivery unconfirmed: ${message.delivery_error}`
      );
    } catch (err) {
      console.error(
        `Failed to flag interrupted automated follow-up ${message.id} for attention:`,
        err
      );
    }
  }
}

async function runAutomatedFollowUps() {
  if (sweepRunning) return;

  sweepRunning = true;
  try {
    // Recovery is independent of the current tool setting. A staff member
    // may disable the tool after a restart, but an already-claimed message
    // must still become visible and retryable in the Inbox.
    await recoverInterruptedFollowUps();

    const settings = getActiveSettings();
    if (!settings) return;

    const candidates = await followUpRepo.findCandidates({
      delayMinutes: settings.delayMinutes,
      triggerMode: settings.triggerMode,
      activatedAt: settings.activatedAt,
      limit: FOLLOW_UP_BATCH_SIZE,
    });

    for (const candidate of candidates) {
      try {
        await sendCandidate(candidate);
      } catch (err) {
        console.error(
          `Failed to process automated follow-up for contact ${candidate.contact_id}:`,
          err
        );
      }
    }
  } catch (err) {
    console.error("Automated follow-up sweep failed:", err);
  } finally {
    sweepRunning = false;
  }
}

function startAutomatedFollowUps() {
  runAutomatedFollowUps();
  const timer = setInterval(runAutomatedFollowUps, FOLLOW_UP_CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = {
  FOLLOW_UP_CHECK_INTERVAL_MS,
  STALE_CLAIM_GRACE_MINUTES,
  runAutomatedFollowUps,
  startAutomatedFollowUps,
};
