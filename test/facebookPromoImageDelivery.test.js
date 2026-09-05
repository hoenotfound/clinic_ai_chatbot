const test = require("node:test");
const assert = require("node:assert/strict");

const promoImagesRepo = require("../src/db/promoImagesRepo");
const meta = require("../src/services/metaMessagingService");
const metaAttachments = require("../src/services/metaAttachmentService");
const messagingPolicy = require("../src/services/whatsappPolicyService");
const messaging = require("../src/services/channelMessagingService");

test.beforeEach((t) => {
  const originalPolicy = messagingPolicy.checkFreeformAllowed;
  messagingPolicy.checkFreeformAllowed = async () => ({ allowed: true });
  t.after(() => {
    messagingPolicy.checkFreeformAllowed = originalPolicy;
  });
});

test("Facebook stored promo URL uploads the existing Postgres bytes instead of asking Meta to fetch the URL", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalSendText = meta.sendText;
  const originalSendImage = meta.sendImage;
  const originalSendBuffer = metaAttachments.sendBuffer;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    meta.sendText = originalSendText;
    meta.sendImage = originalSendImage;
    metaAttachments.sendBuffer = originalSendBuffer;
  });

  const calls = [];
  promoImagesRepo.getImage = async (id) => {
    calls.push({ kind: "load", id });
    return {
      mime_type: "image/png",
      data: Buffer.from("promo-png").toString("base64"),
    };
  };
  meta.sendText = async (channel, to, text) => {
    calls.push({ kind: "caption", channel, to, text });
    return { success: true, externalMessageId: "caption-1" };
  };
  meta.sendImage = async () => {
    calls.push({ kind: "remote-url" });
    return { success: false, error: "must not use remote URL" };
  };
  metaAttachments.sendBuffer = async (channel, to, type, buffer, mimeType, filename) => {
    calls.push({
      kind: "buffer",
      channel,
      to,
      type,
      bytes: buffer.toString(),
      mimeType,
      filename,
    });
    return { success: true, externalMessageId: "image-1" };
  };

  const result = await messaging.sendImageByUrl(
    { channel: "facebook", channel_user_id: "psid-123" },
    "https://clinic.example.com/promo-images/42",
    "Promo caption"
  );

  assert.equal(result.success, true);
  assert.deepEqual(calls, [
    { kind: "load", id: 42 },
    {
      kind: "caption",
      channel: "facebook",
      to: "psid-123",
      text: "Promo caption",
    },
    {
      kind: "buffer",
      channel: "facebook",
      to: "psid-123",
      type: "image",
      bytes: "promo-png",
      mimeType: "image/png",
      filename: "promo-42.png",
    },
  ]);
});

test("Facebook external image URLs keep the existing URL-send behavior", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalSendImage = meta.sendImage;
  const originalSendBuffer = metaAttachments.sendBuffer;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    meta.sendImage = originalSendImage;
    metaAttachments.sendBuffer = originalSendBuffer;
  });

  let dbReads = 0;
  let bufferUploads = 0;
  let remoteCall = null;
  promoImagesRepo.getImage = async () => {
    dbReads += 1;
    return null;
  };
  metaAttachments.sendBuffer = async () => {
    bufferUploads += 1;
    return { success: true };
  };
  meta.sendImage = async (channel, to, url, caption) => {
    remoteCall = { channel, to, url, caption };
    return { success: true, externalMessageId: "remote-1" };
  };

  const result = await messaging.sendImageByUrl(
    { channel: "facebook", channel_user_id: "psid-456" },
    "https://cdn.example.com/promo.jpg",
    "External promo"
  );

  assert.equal(result.success, true);
  assert.equal(dbReads, 0);
  assert.equal(bufferUploads, 0);
  assert.deepEqual(remoteCall, {
    channel: "facebook",
    to: "psid-456",
    url: "https://cdn.example.com/promo.jpg",
    caption: "External promo",
  });
});

test("A missing stored Facebook promo fails clearly instead of falling back to the same broken remote URL fetch", async (t) => {
  const originalGetImage = promoImagesRepo.getImage;
  const originalSendImage = meta.sendImage;
  const originalSendBuffer = metaAttachments.sendBuffer;
  t.after(() => {
    promoImagesRepo.getImage = originalGetImage;
    meta.sendImage = originalSendImage;
    metaAttachments.sendBuffer = originalSendBuffer;
  });

  promoImagesRepo.getImage = async () => null;
  let remoteSends = 0;
  let bufferSends = 0;
  meta.sendImage = async () => {
    remoteSends += 1;
    return { success: true };
  };
  metaAttachments.sendBuffer = async () => {
    bufferSends += 1;
    return { success: true };
  };

  const result = await messaging.sendImageByUrl(
    { channel: "facebook", channel_user_id: "psid-789" },
    "/promo-images/999",
    undefined
  );

  assert.equal(result.success, false);
  assert.match(result.error, /missing or invalid/i);
  assert.equal(remoteSends, 0);
  assert.equal(bufferSends, 0);
});
