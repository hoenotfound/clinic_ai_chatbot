const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const meta = require("../src/services/metaMessagingService");
const metaAttachments = require("../src/services/metaAttachmentService");
const messaging = require("../src/services/channelMessagingService");

test("WhatsApp contacts keep using the existing WhatsApp send function", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  const originalMetaSend = meta.sendText;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
    meta.sendText = originalMetaSend;
  });

  let whatsappCall = null;
  let metaCalls = 0;
  whatsapp.sendMessage = async (to, text) => {
    whatsappCall = { to, text };
    return { success: true, wamid: "wamid-1" };
  };
  meta.sendText = async () => {
    metaCalls += 1;
    return { success: true, wamid: null };
  };

  const result = await messaging.sendText(
    { channel: "whatsapp", whatsapp_number: "60123456789" },
    "Hello"
  );

  assert.deepEqual(whatsappCall, { to: "60123456789", text: "Hello" });
  assert.equal(metaCalls, 0);
  assert.equal(result.wamid, "wamid-1");
});

test("Facebook contacts never fall through to WhatsApp", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  const originalMetaSend = meta.sendText;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
    meta.sendText = originalMetaSend;
  });

  let whatsappCalls = 0;
  let metaCall = null;
  whatsapp.sendMessage = async () => {
    whatsappCalls += 1;
    return { success: true, wamid: "wrong" };
  };
  meta.sendText = async (channel, to, text) => {
    metaCall = { channel, to, text };
    return { success: true, wamid: null, externalMessageId: "fb-1" };
  };

  await messaging.sendText(
    { channel: "facebook", channel_user_id: "psid-123", whatsapp_number: "facebook:psid-123" },
    "Hello FB"
  );

  assert.equal(whatsappCalls, 0);
  assert.deepEqual(metaCall, {
    channel: "facebook",
    to: "psid-123",
    text: "Hello FB",
  });
});

test("Instagram image bytes send caption then image attachment", async (t) => {
  const originalMetaSend = meta.sendText;
  const originalAttachmentSend = metaAttachments.sendBuffer;
  t.after(() => {
    meta.sendText = originalMetaSend;
    metaAttachments.sendBuffer = originalAttachmentSend;
  });

  const calls = [];
  meta.sendText = async (channel, to, text) => {
    calls.push({ kind: "text", channel, to, text });
    return { success: true, wamid: null, externalMessageId: "caption-1" };
  };
  metaAttachments.sendBuffer = async (channel, to, type, buffer, mimeType, filename) => {
    calls.push({ kind: "attachment", channel, to, type, bytes: buffer.toString(), mimeType, filename });
    return { success: true, wamid: null, externalMessageId: "image-1" };
  };

  const result = await messaging.sendImageBuffer(
    { channel: "instagram", channel_user_id: "igsid-123" },
    Buffer.from("image-data"),
    "image/jpeg",
    "Hello from IG",
    "photo.jpg"
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    { kind: "text", channel: "instagram", to: "igsid-123", text: "Hello from IG" },
    {
      kind: "attachment",
      channel: "instagram",
      to: "igsid-123",
      type: "image",
      bytes: "image-data",
      mimeType: "image/jpeg",
      filename: "photo.jpg",
    },
  ]);
});

test("Facebook voice bytes route to an audio attachment without WhatsApp", async (t) => {
  const originalWhatsappUpload = whatsapp.uploadMedia;
  const originalAttachmentSend = metaAttachments.sendBuffer;
  t.after(() => {
    whatsapp.uploadMedia = originalWhatsappUpload;
    metaAttachments.sendBuffer = originalAttachmentSend;
  });

  let whatsappCalls = 0;
  let attachmentCall = null;
  whatsapp.uploadMedia = async () => {
    whatsappCalls += 1;
    return "wrong";
  };
  metaAttachments.sendBuffer = async (channel, to, type, buffer, mimeType, filename) => {
    attachmentCall = { channel, to, type, bytes: buffer.toString(), mimeType, filename };
    return { success: true, wamid: null, externalMessageId: "voice-1" };
  };

  const result = await messaging.sendAudioBuffer(
    { channel: "facebook", channel_user_id: "psid-voice" },
    Buffer.from("mp3-data"),
    "audio/mpeg",
    "voice.mp3"
  );

  assert.equal(result.success, true);
  assert.equal(whatsappCalls, 0);
  assert.deepEqual(attachmentCall, {
    channel: "facebook",
    to: "psid-voice",
    type: "audio",
    bytes: "mp3-data",
    mimeType: "audio/mpeg",
    filename: "voice.mp3",
  });
});
