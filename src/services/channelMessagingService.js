const contactsRepo = require("../db/contactsRepo");
const whatsapp = require("./whatsappService");
const meta = require("./metaMessagingService");
const metaAttachments = require("./metaAttachmentService");

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

async function sendText(contact, text) {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
    return whatsapp.sendMessage(contact.whatsapp_number, text);
  }
  return meta.sendText(channel, recipientFor(contact), text);
}

async function sendImageByUrl(contact, imageUrl, caption) {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
    return whatsapp.sendImage(contact.whatsapp_number, imageUrl, caption);
  }
  return meta.sendImage(channel, recipientFor(contact), imageUrl, caption);
}

async function sendImageBuffer(contact, buffer, mimeType, caption, filename = "image") {
  const channel = channelOf(contact);
  if (channel === "whatsapp") {
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

  // Keep the simple generic path for retries/tests that are not tied to an
  // active Staff takeover. Active Staff sends split upload from delivery so we
  // can re-check the takeover after the potentially slow upload finishes.
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
