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
    id: candidate.contact_id,
    channel: candidate.channel || "whatsapp",
    whatsapp_number: candidate.whatsapp_number,
    channel_user_id: candidate.channel_user_id,
  };
}

function rejectedFollowUpError(channel) {
  return `${channelMessaging.labelForChannel(channel)} did not accept this automated follow-up. Check the reply window or connection and retry it from the Inbox.`;
}

async function markContacted(contactId) {
  try {
    await pipelineRepo.markContactedForContact(
      contactId,
      "Automated follow-up"
    );
  } catch (err) {
    console.error(
      `Failed to mark lead ${contactId} as contacted after automated follow-up:`,
      err
    );
  }
}

async function sendSocialImageCompanion(contact, contactId, imageUrl) {
  let imageMessage;
  try {
    imageMessage = await followUpRepo.saveSocialImageCompanion({
      contactId,
      imageUrl,
    });
  } catch (err) {
    console.error(
      `Failed to save optional social follow-up image for contact ${contactId}:`,
      err
    );
    await contactsRepo.setDeliveryAttention(
      contactId,
      "Follow-up text was sent, but the optional follow-up graphic could not be queued."
    );
    return;
  }

  if (!imageMessage) return;
  publishConversationChange(imageMessage, "message");

  let imageResult;
  try {
    // Facebook Messenger and Instagram cannot attach caption text to this
    // image in the same API message. The follow-up text has already been sent
    // and recorded, so this companion must contain only the image. A retry can
    // then resend the image without duplicating the customer-facing text.
    imageResult = await channelMessaging.sendImageByUrl(contact, imageUrl, undefined);
  } catch (err) {
    console.error("Optional social follow-up image send failed:", err);
    imageResult = { success: false, wamid: null, externalMessageId: null };
  }

  const imageError = `${channelMessaging.labelForChannel(contact.channel)} did not accept the optional follow-up graphic. The follow-up text was sent; retry this image from the Inbox if needed.`;
  const finalImageMessage =
    (await messagesRepo.setDeliveryStatusById(
      imageMessage.id,
      imageResult?.success ? "sent" : "failed",
      imageResult?.success ? null : imageError
    )) || imageMessage;
  publishConversationChange(finalImageMessage, "delivery_status");

  if (!imageResult?.success) {
    await contactsRepo.setDeliveryAttention(
      contactId,
      `Delivery failed: ${imageError}`
    );
  }
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
  const contact = contactForCandidate(candidate);
  const channel = contact.channel || "whatsapp";
  const isSocial = channel === "facebook" || channel === "instagram";

  // WhatsApp can send its image + caption as one tracked message. Messenger
  // and Instagram require separate text/image API messages, so the atomic
  // follow-up claim represents only the durable text message on those channels.
  const saved = await followUpRepo.saveIfStillEligible({
    contactId: candidate.contact_id,
    triggerMessageId: candidate.trigger_message_id,
    content: followUpMessage,
    mediaUrl: !isSocial && settings.imageUrl ? settings.imageUrl : null,
    delayMinutes: settings.delayMinutes,
    triggerMode: settings.triggerMode,
    activatedAt: settings.activatedAt,
  });

  // The customer may have replied since the candidate query, or another
  // server instance may already have claimed this exact trigger.
  if (!saved) return;

  publishConversationChange(saved, "message");

  const rejectedError = rejectedFollowUpError(channel);

  let sendResult;
  try {
    if (isSocial) {
      // Record the follow-up text separately from an optional image so an image
      // failure/retry can never duplicate a text message Meta already accepted.
      sendResult = await channelMessaging.sendText(contact, followUpMessage);
    } else {
      sendResult = settings.imageUrl
        ? await channelMessaging.sendImageByUrl(
            contact,
            settings.imageUrl,
            followUpMessage
          )
        : await channelMessaging.sendText(contact, followUpMessage);
    }
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
        sendResult?.error || rejectedError
      )) || saved;
  } else if (isSocial) {
    // Messenger/Instagram return an accepted send result but do not use the
    // WhatsApp WAMID webhook pipeline. Mark the text accepted before doing any
    // optional image work, so a later image failure cannot make the text retryable.
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(saved.id, "sent", null)) || saved;
  }

  publishConversationChange(finalMessage, "delivery_status");

  if (!sendResult?.success) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      `Delivery failed: ${sendResult?.error || rejectedError}`
    );
    return;
  }

  // The successful text/WhatsApp follow-up is enough to move a new lead to
  // Contacted. Optional social image delivery is tracked independently below.
  await markContacted(candidate.contact_id);

  if (isSocial && settings.imageUrl) {
    await sendSocialImageCompanion(
      contact,
      candidate.contact_id,
      settings.imageUrl
    );
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
