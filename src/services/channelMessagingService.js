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
    return whatsapp.sendVoiceById(contact.whatsapp_number, mediaId);
  }

  return metaAttachments.sendBuffer(
    channel,
    recipientFor(contact),
    "audio",
    buffer,
    mimeType,
    filename
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
