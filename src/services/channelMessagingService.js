const contactsRepo = require("../db/contactsRepo");
const whatsapp = require("./whatsappService");
const meta = require("./metaMessagingService");
const metaAttachments = require("./metaAttachmentService");
const mediaStorage = require("./mediaStorageService");
const audioConvert = require("./audioConvertService");
const whatsappPolicy = require("./whatsappPolicyService");

function channelOf(contactOrIncoming) {
  return contactOrIncoming?.channel || "whatsapp";
}

function labelForChannel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

function recipientFor(contact) {
  const channel = channelOf(contact);
  return channel === "whatsapp"
    ? contact.whatsapp_number
    : contact.channel_user_id;
}

function rejectedError(channel) {
  const label = labelForChannel(channel);
  return `${label} did not accept this message. Check the reply window or connection and try again.`;
}

function staffModeChangedResult() {
  return {
    success: false,
    wamid: null,
    externalMessageId: null,
    error: "This conversation is no longer in Staff mode.",
  };
}

async function whatsappFreeformGuard(contact, purpose = "service") {
  if (channelOf(contact) !== "whatsapp") return null;
  try {
    const policy = await whatsappPolicy.checkFreeformAllowed(contact, new Date(), {
      purpose,
    });
    return policy.allowed ? null : whatsappPolicy.blockedSendResult(policy);
  } catch (err) {
    // The policy gate is deliberately fail-closed, but a temporary database
    // problem should still look like a normal failed delivery to callers. This
    // lets Inbox/retry/scheduler paths persist a clear failure instead of
    // throwing after an outbound row has already been saved.
    console.error("Failed to verify WhatsApp messaging-policy state:", err);
    return whatsappPolicy.blockedSendResult({
      code: "policy_state_unavailable",
      message:
        "WhatsApp send blocked because messaging-policy state could not be verified. Please retry after the connection recovers.",
    });
  }
}

async function stillInStaffMode(contact) {
  // Voice retries or lower-level calls that are not tied to an active Staff
  // takeover keep their existing behavior. The Inbox voice route always passes
  // a persisted human-mode contact, so it receives the race-condition guard.
  if (contact?.mode !== "human" || !contact?.id) return true;

  try {
    const latest = await contactsRepo.getContactById(contact.id);
    return !!latest && latest.mode === "human";
  } catch (err) {
    // Fail closed here: once the media has uploaded, do not risk delivering a
    // staff voice message if we cannot confirm that the takeover is still active.
    console.error(`Failed to confirm Staff mode for contact ${contact.id}:`, err);
    return false;
  }
}

function temporaryMediaFailure(channel, err) {
  const label = labelForChannel(channel);
  console.error(`${label} temporary media preparation failed:`, err);
  return {
    success: false,
    wamid: null,
    externalMessageId: null,
    error: `The media could not be prepared for ${label}. Please try again.`,
  };
}

async function withTemporaryMediaUrl(contact, buffer, mimeType, deliver) {
  const channel = channelOf(contact);
  let temporary = null;
  try {
    temporary = await mediaStorage.uploadTemporaryMedia(buffer, mimeType, {
      contactId: contact?.id || channel,
    });
    return await deliver(temporary.url);
  } catch (err) {
    return temporaryMediaFailure(channel, err);
  } finally {
    if (temporary?.key) {
      mediaStorage.scheduleTemporaryMediaDelete(temporary.key);
    }
  }
}

async function sendText(contact, text, options = {}) {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
    const blocked = await whatsappFreeformGuard(contact, options.purpose);
    if (blocked) return blocked;
    return whatsapp.sendMessage(contact.whatsapp_number, text);
  }
  return meta.sendText(channel, recipientFor(contact), text);
}

async function sendImageByUrl(contact, imageUrl, caption, options = {}) {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
    const blocked = await whatsappFreeformGuard(contact, options.purpose);
    if (blocked) return blocked;
    return whatsapp.sendImage(contact.whatsapp_number, imageUrl, caption);
  }
  return meta.sendImage(channel, recipientFor(contact), imageUrl, caption);
}

async function sendImageBuffer(contact, buffer, mimeType, caption, filename = "image") {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
    // Check policy before uploading bytes to Meta. This avoids creating media
    // objects for a message we are not permitted to deliver.
    const blocked = await whatsappFreeformGuard(contact);
    if (blocked) return blocked;

    const mediaId = await whatsapp.uploadMedia(buffer, mimeType, filename);
    if (!mediaId) {
      return {
        success: false,
        wamid: null,
        error: "The image could not be uploaded to WhatsApp.",
      };
    }
    return whatsapp.sendImageById(
      contact.whatsapp_number,
      mediaId,
      caption || undefined
    );
  }

  if (caption?.trim()) {
    const captionResult = await meta.sendText(channel, recipientFor(contact), caption.trim());
    if (!captionResult.success) return captionResult;
  }

  // Live Instagram testing showed that this Page-linked Instagram setup can
  // upload a reusable attachment but rejects the later attachment_id POST.
  // The Send API supports media URLs, so expose only a disposable R2 copy via
  // a short-lived presigned URL. Facebook Messenger keeps its binary upload.
  if (channel === "instagram") {
    return withTemporaryMediaUrl(contact, buffer, mimeType, (mediaUrl) =>
      metaAttachments.sendUrlAttachment(
        channel,
        recipientFor(contact),
        "image",
        mediaUrl
      )
    );
  }

  return metaAttachments.sendBuffer(
    channel,
    recipientFor(contact),
    "image",
    buffer,
    mimeType,
    filename
  );
}

async function sendAudioBuffer(contact, buffer, mimeType, filename = "voice.mp3") {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
    const blocked = await whatsappFreeformGuard(contact);
    if (blocked) return blocked;

    const mediaId = await whatsapp.uploadMedia(buffer, mimeType, filename);
    if (!mediaId) {
      return {
        success: false,
        wamid: null,
        error: "The voice recording could not be uploaded to WhatsApp.",
      };
    }

    if (!(await stillInStaffMode(contact))) {
      return staffModeChangedResult();
    }

    return whatsapp.sendVoiceById(contact.whatsapp_number, mediaId);
  }

  if (channel === "instagram") {
    const instagramAudio = await audioConvert.convertToInstagramAudio(buffer, mimeType);
    if (!instagramAudio) {
      return {
        success: false,
        wamid: null,
        externalMessageId: null,
        error: "The voice recording could not be converted to an Instagram-supported audio format.",
      };
    }

    return withTemporaryMediaUrl(
      contact,
      instagramAudio.buffer,
      instagramAudio.mimeType,
      async (mediaUrl) => {
        // Keep the race-condition protection added for PR #54: conversion and
        // upload can both take time, so re-check immediately before delivery.
        if (!(await stillInStaffMode(contact))) {
          return staffModeChangedResult();
        }
        return metaAttachments.sendUrlAttachment(
          channel,
          recipientFor(contact),
          "audio",
          mediaUrl
        );
      }
    );
  }

  // Facebook Messenger keeps the attachment upload path. Active Staff sends
  // split upload from delivery so we can re-check ownership after the slow
  // upload finishes; retries/tests without an active takeover keep the simple
  // generic path.
  if (contact?.mode !== "human" || !contact?.id) {
    return metaAttachments.sendBuffer(
      channel,
      recipientFor(contact),
      "audio",
      buffer,
      mimeType,
      filename
    );
  }

  const uploaded = await metaAttachments.uploadAttachment(
    channel,
    "audio",
    buffer,
    mimeType,
    filename
  );
  if (!uploaded.success) {
    return {
      success: false,
      wamid: null,
      externalMessageId: null,
      error: uploaded.error,
    };
  }

  if (!(await stillInStaffMode(contact))) {
    return staffModeChangedResult();
  }

  return metaAttachments.sendAttachmentId(
    channel,
    recipientFor(contact),
    "audio",
    uploaded.attachmentId
  );
}

async function downloadIncomingMedia(incoming) {
  const channel = channelOf(incoming);
  if (channel === "whatsapp") {
    return incoming.mediaId ? whatsapp.downloadMedia(incoming.mediaId) : null;
  }
  return incoming.mediaUrl ? meta.downloadMedia(incoming.mediaUrl) : null;
}

module.exports = {
  labelForChannel,
  rejectedError,
  sendText,
  sendImageByUrl,
  sendImageBuffer,
  sendAudioBuffer,
  downloadIncomingMedia,
};
