const test = require("node:test");
const assert = require("node:assert/strict");

const contactsRepo = require("../src/db/contactsRepo");
const whatsapp = require("../src/services/whatsappService");
const meta = require("../src/services/metaMessagingService");
const metaAttachments = require("../src/services/metaAttachmentService");
const mediaStorage = require("../src/services/mediaStorageService");
const promoImagesRepo = require("../src/db/promoImagesRepo");
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

test("WhatsApp quoted reply context reaches the provider sender", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
  });

  let whatsappCall = null;
  whatsapp.sendMessage = async (to, text, options) => {
    whatsappCall = { to, text, options };
    return { success: true, wamid: "wamid-reply" };
  };

  await messaging.sendText(
    { id: 12, channel: "whatsapp", whatsapp_number: "60123456789" },
    "Quoted reply",
    { replyToProviderMessageId: "wamid-original" }
  );

  assert.deepEqual(whatsappCall, {
    to: "60123456789",
    text: "Quoted reply",
    options: { replyToProviderMessageId: "wamid-original" },
  });
});

test("WhatsApp sticker bytes upload then send as a sticker", async (t) => {
  const originalUpload = whatsapp.uploadMedia;
  const originalSendSticker = whatsapp.sendStickerById;
  t.after(() => {
    whatsapp.uploadMedia = originalUpload;
    whatsapp.sendStickerById = originalSendSticker;
  });

  const calls = [];
  whatsapp.uploadMedia = async (buffer, mimeType, filename) => {
    calls.push({
      kind: "upload",
      bytes: buffer.toString(),
      mimeType,
      filename,
    });
    return "wa-sticker-media";
  };
  whatsapp.sendStickerById = async (to, mediaId, options) => {
    calls.push({ kind: "send", to, mediaId, options });
    return { success: true, wamid: "wamid-sticker-forward" };
  };

  const result = await messaging.sendStickerBuffer(
    { id: 13, channel: "whatsapp", whatsapp_number: "60123456789" },
    Buffer.from("sticker-data"),
    "image/webp",
    "sticker.webp",
    { preSendCheck: () => true }
  );

  assert.equal(result.success, true);
  assert.equal(result.wamid, "wamid-sticker-forward");
  assert.deepEqual(calls, [
    {
      kind: "upload",
      bytes: "sticker-data",
      mimeType: "image/webp",
      filename: "sticker.webp",
    },
    {
      kind: "send",
      to: "60123456789",
      mediaId: "wa-sticker-media",
      options: { replyToProviderMessageId: undefined },
    },
  ]);
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

test("Facebook text pre-send guard cancels before Meta is called", async (t) => {
  const originalMetaSend = meta.sendText;
  t.after(() => {
    meta.sendText = originalMetaSend;
  });

  let metaCalls = 0;
  meta.sendText = async () => {
    metaCalls += 1;
    return { success: true, externalMessageId: "must-not-send" };
  };

  const result = await messaging.sendText(
    { channel: "facebook", channel_user_id: "psid-guard" },
    "AI reply",
    { preSendCheck: () => false }
  );

  assert.equal(metaCalls, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.success, false);
});

test("Instagram image URL pre-send guard cancels before Meta is called", async (t) => {
  const originalMetaSend = meta.sendImage;
  t.after(() => {
    meta.sendImage = originalMetaSend;
  });

  let metaCalls = 0;
  meta.sendImage = async () => {
    metaCalls += 1;
    return { success: true, externalMessageId: "must-not-send" };
  };

  const result = await messaging.sendImageByUrl(
    { channel: "instagram", channel_user_id: "igsid-guard" },
    "https://example.com/promo.jpg",
    undefined,
    { preSendCheck: () => false }
  );

  assert.equal(metaCalls, 0);
  assert.equal(result.cancelled, true);
  assert.equal(result.success, false);
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

test("Instagram image bytes record both caption and image provider ids", async (t) => {
  const originalMetaSend = meta.sendText;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  t.after(() => {
    meta.sendText = originalMetaSend;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlSend;
  });

  meta.sendText = async () => ({
    success: true,
    wamid: null,
    externalMessageId: "ig-caption-alias",
  });
  mediaStorage.uploadTemporaryMedia = async () => ({
    key: "meta-outbound/66/image.jpg",
    url: "https://r2.example/image.jpg?signed=1",
  });
  mediaStorage.scheduleTemporaryMediaDelete = () => {};
  metaAttachments.sendUrlAttachment = async () => ({
    success: true,
    wamid: null,
    externalMessageId: "ig-image-alias",
  });

  const recorded = [];
  const result = await messaging.sendImageBuffer(
    { id: 66, channel: "instagram", channel_user_id: "igsid-alias" },
    Buffer.from("image-data"),
    "image/jpeg",
    "Caption",
    "photo.jpg",
    {
      onProviderMessageId: async (id) => {
        recorded.push(id);
      },
    }
  );

  assert.equal(result.success, true);
  assert.deepEqual(recorded, ["ig-caption-alias", "ig-image-alias"]);
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


test("WhatsApp pre-send guard can cancel after policy approval without calling provider", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
  });

  let providerCalls = 0;
  whatsapp.sendMessage = async () => {
    providerCalls += 1;
    return { success: true, wamid: "must-not-send" };
  };

  let guardCalls = 0;
  const result = await messaging.sendText(
    { id: 101, channel: "whatsapp", whatsapp_number: "60128880000" },
    "AI draft",
    {
      preSendCheck: () => {
        guardCalls += 1;
        return false;
      },
    }
  );

  assert.equal(guardCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
});

test("social sends honor the same final pre-send guard as WhatsApp", async (t) => {
  const originalMetaSend = meta.sendText;
  t.after(() => {
    meta.sendText = originalMetaSend;
  });

  let calls = 0;
  meta.sendText = async () => {
    calls += 1;
    return { success: true, externalMessageId: "fb-guard-test" };
  };

  const result = await messaging.sendText(
    { channel: "facebook", channel_user_id: "psid-guard" },
    "Hello",
    { preSendCheck: () => false }
  );

  assert.equal(calls, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
});


test("WhatsApp image pre-send guard cancels automatic promo before provider call", async (t) => {
  const originalSendImage = whatsapp.sendImage;
  t.after(() => {
    whatsapp.sendImage = originalSendImage;
  });

  let providerCalls = 0;
  whatsapp.sendImage = async () => {
    providerCalls += 1;
    return { success: true, wamid: "must-not-send-image" };
  };

  const result = await messaging.sendImageByUrl(
    { id: 102, channel: "whatsapp", whatsapp_number: "60128881111" },
    "https://example.test/promo.jpg",
    "Promo",
    { preSendCheck: () => false }
  );

  assert.equal(providerCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
});


test("social image failure records that its caption was already delivered", async (t) => {
  const originalMetaSend = meta.sendText;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  t.after(() => {
    meta.sendText = originalMetaSend;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlSend;
  });

  meta.sendText = async () => ({
    success: true,
    externalMessageId: null,
  });
  mediaStorage.uploadTemporaryMedia = async () => ({
    key: "meta-outbound/401/image.jpg",
    url: "https://r2.example/image.jpg?signed=1",
  });
  mediaStorage.scheduleTemporaryMediaDelete = () => {};
  metaAttachments.sendUrlAttachment = async () => ({
    success: false,
    externalMessageId: null,
    error: "image rejected",
  });

  const result = await messaging.sendImageBuffer(
    { id: 401, channel: "instagram", channel_user_id: "igsid-partial" },
    Buffer.from("image"),
    "image/jpeg",
    "Already delivered caption",
    "photo.jpg"
  );

  assert.equal(result.success, false);
  assert.equal(result.partialCaptionSent, true);
  assert.equal(result.captionProviderMessageId, null);
  assert.equal(result.error, "image rejected");
});

test("social image retry can skip a caption that was already delivered", async (t) => {
  const originalMetaSend = meta.sendText;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlSend = metaAttachments.sendUrlAttachment;
  t.after(() => {
    meta.sendText = originalMetaSend;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlSend;
  });

  let captionCalls = 0;
  meta.sendText = async () => {
    captionCalls += 1;
    return { success: true, externalMessageId: "must-not-send-caption" };
  };
  mediaStorage.uploadTemporaryMedia = async () => ({
    key: "meta-outbound/402/image.jpg",
    url: "https://r2.example/image.jpg?signed=1",
  });
  mediaStorage.scheduleTemporaryMediaDelete = () => {};
  let imageCalls = 0;
  metaAttachments.sendUrlAttachment = async () => {
    imageCalls += 1;
    return { success: true, externalMessageId: "ig-image-retry" };
  };

  const result = await messaging.sendImageBuffer(
    { id: 402, channel: "instagram", channel_user_id: "igsid-retry" },
    Buffer.from("image"),
    "image/jpeg",
    "Do not resend me",
    "photo.jpg",
    { skipCaption: true }
  );

  assert.equal(result.success, true);
  assert.equal(captionCalls, 0);
  assert.equal(imageCalls, 1);
});


test("Facebook stored promo preserves a delivered caption when late cancellation blocks the image", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalMetaSend = meta.sendText;
  const originalBufferSend = metaAttachments.sendBuffer;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    meta.sendText = originalMetaSend;
    metaAttachments.sendBuffer = originalBufferSend;
  });

  promoImagesRepo.getImage = async (id) => {
    assert.equal(id, 77);
    return {
      id,
      mime_type: "image/jpeg",
      data: Buffer.from("promo-bytes").toString("base64"),
    };
  };

  let captionCalls = 0;
  meta.sendText = async (channel, to, text) => {
    captionCalls += 1;
    assert.equal(channel, "facebook");
    assert.equal(to, "psid-late-cancel");
    assert.equal(text, "Promo caption");
    return {
      success: true,
      externalMessageId: "fb-caption-accepted",
      error: null,
    };
  };

  let imageCalls = 0;
  metaAttachments.sendBuffer = async () => {
    imageCalls += 1;
    return {
      success: true,
      externalMessageId: "must-not-send-image",
      error: null,
    };
  };

  let guardCalls = 0;
  const recordedProviderIds = [];
  const result = await messaging.sendImageByUrl(
    {
      id: 403,
      channel: "facebook",
      channel_user_id: "psid-late-cancel",
    },
    "https://app.example/promo-images/77",
    "Promo caption",
    {
      preSendCheck: () => {
        guardCalls += 1;
        return guardCalls === 1;
      },
      onProviderMessageId: async (id) => {
        recordedProviderIds.push(id);
      },
    }
  );

  assert.equal(guardCalls, 2);
  assert.equal(captionCalls, 1);
  assert.equal(imageCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.partialCaptionSent, true);
  assert.equal(result.captionProviderMessageId, "fb-caption-accepted");
  assert.match(result.error, /staff activity took over/i);
  assert.deepEqual(recordedProviderIds, ["fb-caption-accepted"]);

  metaAttachments.sendBuffer = async () => {
    imageCalls += 1;
    return {
      success: true,
      externalMessageId: "fb-image-retry",
      error: null,
    };
  };

  const retry = await messaging.sendImageByUrl(
    {
      id: 403,
      channel: "facebook",
      channel_user_id: "psid-late-cancel",
    },
    "https://app.example/promo-images/77",
    undefined,
    { skipCaption: true }
  );

  assert.equal(retry.success, true);
  assert.equal(captionCalls, 1);
  assert.equal(imageCalls, 1);
});

test("manual social sends propagate Human Agent only when policy requires it", async (t) => {
  const originalPolicy = whatsappPolicy.checkFreeformAllowed;
  const originalMetaSend = meta.sendText;
  t.after(() => {
    whatsappPolicy.checkFreeformAllowed = originalPolicy;
    meta.sendText = originalMetaSend;
  });

  let requestedPurpose = null;
  whatsappPolicy.checkFreeformAllowed = async (_contact, _now, options) => {
    requestedPurpose = options.purpose;
    return {
      allowed: true,
      humanAgentRequired: options.purpose === "human_agent",
    };
  };

  let providerOptions = null;
  meta.sendText = async (_channel, _to, _text, options) => {
    providerOptions = options;
    return { success: true, externalMessageId: "fb-human-agent-route" };
  };

  const result = await messaging.sendText(
    { id: 501, channel: "facebook", channel_user_id: "psid-501" },
    "Manual staff reply",
    { purpose: "human_agent" }
  );

  assert.equal(result.success, true);
  assert.equal(requestedPurpose, "human_agent");
  assert.equal(providerOptions.humanAgent, true);
});


test("async pre-send guard is awaited before WhatsApp delivery", async (t) => {
  const originalWhatsappSend = whatsapp.sendMessage;
  t.after(() => {
    whatsapp.sendMessage = originalWhatsappSend;
  });

  let providerCalls = 0;
  whatsapp.sendMessage = async () => {
    providerCalls += 1;
    return { success: true, wamid: "must-not-send-async" };
  };

  let guardResolved = false;
  const result = await messaging.sendText(
    { id: 501, channel: "whatsapp", whatsapp_number: "60125010000" },
    "Guarded follow-up",
    {
      preSendCheck: async () => {
        await Promise.resolve();
        guardResolved = true;
        return false;
      },
    }
  );

  assert.equal(guardResolved, true);
  assert.equal(providerCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
});

test("pre-send guard failures fail closed before provider delivery", async (t) => {
  const originalMetaSend = meta.sendText;
  t.after(() => {
    meta.sendText = originalMetaSend;
  });

  let providerCalls = 0;
  meta.sendText = async () => {
    providerCalls += 1;
    return { success: true, externalMessageId: "must-not-send-error" };
  };

  const result = await messaging.sendText(
    { id: 502, channel: "facebook", channel_user_id: "psid-async-error" },
    "Guarded follow-up",
    {
      preSendCheck: async () => {
        throw new Error("database unavailable");
      },
    }
  );

  assert.equal(providerCalls, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.preSendCheckFailed, true);
  assert.match(result.error, /eligibility could not be verified/i);
});


test("WhatsApp stored result media uses private bytes upload instead of a public image URL", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalUpload = whatsapp.uploadMedia;
  const originalSendById = whatsapp.sendImageById;
  const originalSendByUrl = whatsapp.sendImage;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    whatsapp.uploadMedia = originalUpload;
    whatsapp.sendImageById = originalSendById;
    whatsapp.sendImage = originalSendByUrl;
  });

  promoImagesRepo.getImage = async (id) => {
    assert.equal(id, 321);
    return {
      mime_type: "image/jpeg",
      data: Buffer.from("private-result").toString("base64"),
      purpose: "result_media",
    };
  };

  const calls = [];
  whatsapp.uploadMedia = async (buffer, mimeType, filename) => {
    calls.push({
      kind: "upload",
      bytes: buffer.toString(),
      mimeType,
      filename,
    });
    return "wa-media-321";
  };
  whatsapp.sendImageById = async (to, mediaId, caption) => {
    calls.push({ kind: "send-by-id", to, mediaId, caption });
    return { success: true, wamid: "wamid-private-result" };
  };
  whatsapp.sendImage = async () => {
    calls.push({ kind: "public-url-send" });
    return { success: false, wamid: null };
  };

  let guardCalls = 0;
  const result = await messaging.sendImageByUrl(
    { id: 3210, channel: "whatsapp", whatsapp_number: "60123334444" },
    "/api/config/result-media/image/321",
    "Before & after reference",
    {
      preSendCheck: () => {
        guardCalls += 1;
        return true;
      },
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.wamid, "wamid-private-result");
  assert.equal(guardCalls, 2);
  assert.deepEqual(calls, [
    {
      kind: "upload",
      bytes: "private-result",
      mimeType: "image/jpeg",
      filename: "promo-321.jpg",
    },
    {
      kind: "send-by-id",
      to: "60123334444",
      mediaId: "wa-media-321",
      caption: "Before & after reference",
    },
  ]);
});

test("Instagram stored result media uses only a short-lived signed R2 URL", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalMetaSend = meta.sendText;
  const originalMetaImage = meta.sendImage;
  const originalUploadTemporary = mediaStorage.uploadTemporaryMedia;
  const originalScheduleDelete = mediaStorage.scheduleTemporaryMediaDelete;
  const originalUrlAttachment = metaAttachments.sendUrlAttachment;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    meta.sendText = originalMetaSend;
    meta.sendImage = originalMetaImage;
    mediaStorage.uploadTemporaryMedia = originalUploadTemporary;
    mediaStorage.scheduleTemporaryMediaDelete = originalScheduleDelete;
    metaAttachments.sendUrlAttachment = originalUrlAttachment;
  });

  promoImagesRepo.getImage = async (id) => ({
    mime_type: "image/png",
    data: Buffer.from(`result-${id}`).toString("base64"),
    purpose: "result_media",
  });
  meta.sendText = async () => ({
    success: true,
    externalMessageId: "ig-private-caption",
  });
  let permanentUrlCalls = 0;
  meta.sendImage = async () => {
    permanentUrlCalls += 1;
    return { success: false, externalMessageId: null };
  };

  const events = [];
  mediaStorage.uploadTemporaryMedia = async (buffer, mimeType, options) => {
    events.push({
      kind: "temp-upload",
      bytes: buffer.toString(),
      mimeType,
      contactId: options.contactId,
    });
    return {
      key: "meta-outbound/654/result.png",
      url: "https://r2.example/result.png?signed=temporary",
    };
  };
  mediaStorage.scheduleTemporaryMediaDelete = (key) => {
    events.push({ kind: "cleanup", key });
  };
  metaAttachments.sendUrlAttachment = async (_channel, _to, _type, url) => {
    events.push({ kind: "deliver", url });
    return { success: true, externalMessageId: "ig-private-image" };
  };

  const result = await messaging.sendImageByUrl(
    { id: 654, channel: "instagram", channel_user_id: "igsid-private" },
    "/api/config/result-media/image/654",
    "Private example",
    { preSendCheck: () => true }
  );

  assert.equal(result.success, true);
  assert.equal(permanentUrlCalls, 0);
  assert.deepEqual(events, [
    {
      kind: "temp-upload",
      bytes: "result-654",
      mimeType: "image/png",
      contactId: 654,
    },
    {
      kind: "deliver",
      url: "https://r2.example/result.png?signed=temporary",
    },
    { kind: "cleanup", key: "meta-outbound/654/result.png" },
  ]);
});

test("WhatsApp stored image delivery rechecks automation ownership after upload", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalUpload = whatsapp.uploadMedia;
  const originalSendById = whatsapp.sendImageById;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    whatsapp.uploadMedia = originalUpload;
    whatsapp.sendImageById = originalSendById;
  });

  promoImagesRepo.getImage = async () => ({
    mime_type: "image/jpeg",
    data: Buffer.from("private-result").toString("base64"),
    purpose: "result_media",
  });
  whatsapp.uploadMedia = async () => "uploaded-before-takeover";
  let deliveries = 0;
  whatsapp.sendImageById = async () => {
    deliveries += 1;
    return { success: true, wamid: "must-not-send" };
  };

  let guardCalls = 0;
  const result = await messaging.sendImageByUrl(
    { id: 777, channel: "whatsapp", whatsapp_number: "60127770000" },
    "/api/config/result-media/image/777",
    "Result",
    {
      preSendCheck: () => {
        guardCalls += 1;
        return guardCalls === 1;
      },
    }
  );

  assert.equal(guardCalls, 2);
  assert.equal(deliveries, 0);
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
});
