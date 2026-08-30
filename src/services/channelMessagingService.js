const whatsapp = require("./whatsappService");
const meta = require("./metaMessagingService");

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
  downloadIncomingMedia,
};
