const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const whatsapp = require("../src/services/whatsappService");
const meta = require("../src/services/metaMessagingService");
const metaAttachments = require("../src/services/metaAttachmentService");
const mediaStorage = require("../src/services/mediaStorageService");
const audioConvert = require("../src/services/audioConvertService");
const whatsappPolicy = require("../src/services/whatsappPolicyService");
const messaging = require("../src/services/channelMessagingService");

test.beforeEach((t) => {
  const original = whatsappPolicy.checkFreeformAllowed;
  whatsappPolicy.checkFreeformAllowed = async () => ({ allowed: true });
  t.after(() => {
    whatsappPolicy.checkFreeformAllowed = original;
  });
});

test("WhatsApp contacts keep using the existing WhatsApp send function after policy approval", async (t) => {
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
    { id: 1, channel: "whatsapp", whatsapp_number: "60123456789" },
    "Hello"
  );

  assert.deepEqual(whatsappCall, { to: "60123456789", text: "Hello" });
  assert.equal(metaCalls, 0);
  assert.equal(result.wamid, "wamid-1");
});

test("WhatsApp policy rejection blocks the lower-level send", async (t) => {
  const originalPolicy = whatsappPolicy.checkFreeformAllowed;
  const originalWhatsappSend = whatsapp.sendMessage;
  t.after(() => {
    whatsappPolicy.checkFreeformAllowed = originalPolicy;
    whatsapp.sendMessage = originalWhatsappSend;
  });

  whatsappPolicy.checkFreeformAllowed = async () => ({
    allowed: false,
    code: "outside_customer_service_window",
    message: "window closed",
  });
  let whatsappCalls = 0;
  whatsapp.sendMessage = async () => {
    whatsappCalls += 1;
    return { success: true, wamid: "wrong" };
  };

  const result = await messaging.sendText(
    { id: 2, channel: "whatsapp", whatsapp_number: "60123456789" },
    "Too late"
  );

  assert.equal(whatsappCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.policyBlocked, true);
  assert.equal(result.policyCode, "outside_customer_service_window");
  assert.equal(result.error, "window closed");
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

test("Instagram image bytes use a short-lived media URL instead of attachment_id", async (t) => {
  const originalMetaSend = meta.sendText;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  const originalBufferSend = metaAttachments.sendBuffer;
  t.after(() => {
    meta.sendText = originalMetaSend;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlSend;
    metaAttachments.sendBuffer = originalBufferSend;
  });

  const calls = [];
  meta.sendText = async (channel, to, text) => {
    calls.push({ kind: "text", channel, to, text });
    return { success: true, wamid: null, externalMessageId: "caption-1" };
  };
  mediaStorage.uploadTemporaryMedia = async (buffer, mimeType, options) => {
    calls.push({
      kind: "temp-upload",
      bytes: buffer.toString(),
      mimeType,
      contactId: options.contactId,
    });
    return {
      key: "meta-outbound/44/image.jpg",
      url: "https://r2.example/image.jpg?signed=1",
    };
  };
  mediaStorage.scheduleTemporaryMediaDelete = (key) => {
    calls.push({ kind: "cleanup", key });
  };
  metaAttachments.sendUrlAttachment = async (channel, to, type, mediaUrl) => {
    calls.push({ kind: "url-attachment", channel, to, type, mediaUrl });
    return { success: true, wamid: null, externalMessageId: "image-1" };
  };
  let bufferSends = 0;
  metaAttachments.sendBuffer = async () => {
    bufferSends += 1;
    return { success: true, externalMessageId: "wrong" };
  };

  const result = await messaging.sendImageBuffer(
    { id: 44, channel: "instagram", channel_user_id: "igsid-123" },
    Buffer.from("image-data"),
    "image/jpeg",
    "Hello from IG",
    "photo.jpg"
  );

  assert.equal(result.success, true);
  assert.equal(bufferSends, 0);
  assert.deepEqual(calls, [
    { kind: "text", channel: "instagram", to: "igsid-123", text: "Hello from IG" },
    { kind: "temp-upload", bytes: "image-data", mimeType: "image/jpeg", contactId: 44 },
    {
      kind: "url-attachment",
      channel: "instagram",
      to: "igsid-123",
      type: "image",
      mediaUrl: "https://r2.example/image.jpg?signed=1",
    },
    { kind: "cleanup", key: "meta-outbound/44/image.jpg" },
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

test("Instagram voice is converted to M4A before temporary URL delivery", async (t) => {
  const originalConvert = audioConvert.convertToInstagramAudio;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  t.after(() => {
    audioConvert.convertToInstagramAudio = originalConvert;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlSend;
  });

  const calls = [];
  audioConvert.convertToInstagramAudio = async (buffer, mimeType) => {
    calls.push({ kind: "convert", bytes: buffer.toString(), mimeType });
    return {
      buffer: Buffer.from("m4a-data"),
      mimeType: "audio/mp4",
      filename: "voice.m4a",
    };
  };
  mediaStorage.uploadTemporaryMedia = async (buffer, mimeType, options) => {
    calls.push({
      kind: "temp-upload",
      bytes: buffer.toString(),
      mimeType,
      contactId: options.contactId,
    });
    return {
      key: "meta-outbound/55/voice.m4a",
      url: "https://r2.example/voice.m4a?signed=1",
    };
  };
  mediaStorage.scheduleTemporaryMediaDelete = (key) => {
    calls.push({ kind: "cleanup", key });
  };
  metaAttachments.sendUrlAttachment = async (channel, to, type, mediaUrl) => {
    calls.push({ kind: "url-attachment", channel, to, type, mediaUrl });
    return { success: true, wamid: null, externalMessageId: "voice-ig-1" };
  };

  const result = await messaging.sendAudioBuffer(
    { id: 55, channel: "instagram", channel_user_id: "igsid-voice" },
    Buffer.from("stored-mp3"),
    "audio/mpeg",
    "voice.mp3"
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    { kind: "convert", bytes: "stored-mp3", mimeType: "audio/mpeg" },
    { kind: "temp-upload", bytes: "m4a-data", mimeType: "audio/mp4", contactId: 55 },
    {
      kind: "url-attachment",
      channel: "instagram",
      to: "igsid-voice",
      type: "audio",
      mediaUrl: "https://r2.example/voice.m4a?signed=1",
    },
    { kind: "cleanup", key: "meta-outbound/55/voice.m4a" },
  ]);
});

test("WhatsApp voice is not delivered if Staff mode ends during media upload", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  const originalUpload = whatsapp.uploadMedia;
  const originalSendVoice = whatsapp.sendVoiceById;
  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
    whatsapp.uploadMedia = originalUpload;
    whatsapp.sendVoiceById = originalSendVoice;
  });

  whatsapp.uploadMedia = async () => "voice-media-id";
  contactsRepo.getContactById = async () => ({ id: 77, mode: "ai" });
  let deliveries = 0;
  whatsapp.sendVoiceById = async () => {
    deliveries += 1;
    return { success: true, wamid: "should-not-send" };
  };

  const result = await messaging.sendAudioBuffer(
    {
      id: 77,
      mode: "human",
      channel: "whatsapp",
      whatsapp_number: "60111111111",
    },
    Buffer.from("ogg-data"),
    "audio/ogg",
    "voice.ogg"
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "This conversation is no longer in Staff mode.");
  assert.equal(deliveries, 0);
});

test("Instagram policy rejection blocks media preparation and delivery", async (t) => {
  const originalPolicy = whatsappPolicy.checkFreeformAllowed;
  const originalConvert = audioConvert.convertToInstagramAudio;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  t.after(() => {
    whatsappPolicy.checkFreeformAllowed = originalPolicy;
    audioConvert.convertToInstagramAudio = originalConvert;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    metaAttachments.sendUrlAttachment = originalUrlSend;
  });

  whatsappPolicy.checkFreeformAllowed = async () => ({
    allowed: false,
    code: "outside_customer_service_window",
    message: "Instagram reply window closed",
  });
  let preparationCalls = 0;
  audioConvert.convertToInstagramAudio = async () => {
    preparationCalls += 1;
    throw new Error("must not convert");
  };
  mediaStorage.uploadTemporaryMedia = async () => {
    preparationCalls += 1;
    throw new Error("must not upload");
  };
  metaAttachments.sendUrlAttachment = async () => {
    preparationCalls += 1;
    throw new Error("must not deliver");
  };

  const result = await messaging.sendAudioBuffer(
    { id: 99, channel: "instagram", channel_user_id: "igsid-blocked" },
    Buffer.from("audio"),
    "audio/mpeg",
    "voice.mp3"
  );

  assert.equal(preparationCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.policyBlocked, true);
  assert.equal(result.policyCode, "outside_customer_service_window");
  assert.equal(result.error, "Instagram reply window closed");
});

test("Instagram voice is not delivered if Staff mode ends during temporary upload", async (t) => {
  const originalGetContact = contactsRepo.getContactById;
  const originalConvert = audioConvert.convertToInstagramAudio;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  t.after(() => {
    contactsRepo.getContactById = originalGetContact;
    audioConvert.convertToInstagramAudio = originalConvert;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlSend;
  });

  audioConvert.convertToInstagramAudio = async () => ({
    buffer: Buffer.from("m4a-data"),
    mimeType: "audio/mp4",
    filename: "voice.m4a",
  });
  mediaStorage.uploadTemporaryMedia = async (buffer, mimeType) => {
    assert.equal(buffer.toString(), "m4a-data");
    assert.equal(mimeType, "audio/mp4");
    return {
      key: "meta-outbound/88/voice.m4a",
      url: "https://r2.example/voice.m4a?signed=1",
    };
  };
  let cleanedKey = null;
  mediaStorage.scheduleTemporaryMediaDelete = (key) => {
    cleanedKey = key;
  };
  contactsRepo.getContactById = async () => ({ id: 88, mode: "ai" });
  let deliveries = 0;
  metaAttachments.sendUrlAttachment = async () => {
    deliveries += 1;
    return { success: true, wamid: null, externalMessageId: "should-not-send" };
  };

  const result = await messaging.sendAudioBuffer(
    {
      id: 88,
      mode: "human",
      channel: "instagram",
      channel_user_id: "igsid-race",
    },
    Buffer.from("mp3-data"),
    "audio/mpeg",
    "voice.mp3"
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "This conversation is no longer in Staff mode.");
  assert.equal(deliveries, 0);
  assert.equal(cleanedKey, "meta-outbound/88/voice.m4a");
});
