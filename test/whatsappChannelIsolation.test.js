const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const meta = require("../src/services/metaMessagingService");
const whatsappPolicy = require("../src/services/whatsappPolicyService");
const messaging = require("../src/services/channelMessagingService");

test("WhatsApp promo images still use the existing WhatsApp sendImage function", async (t) => {
  const originalWhatsappSendImage = whatsapp.sendImage;
  const originalMetaSendImage = meta.sendImage;
  const originalPolicyCheck = whatsappPolicy.checkFreeformAllowed;
  t.after(() => {
    whatsapp.sendImage = originalWhatsappSendImage;
    meta.sendImage = originalMetaSendImage;
    whatsappPolicy.checkFreeformAllowed = originalPolicyCheck;
  });

  whatsappPolicy.checkFreeformAllowed = async () => ({ allowed: true });
  let whatsappCall = null;
  let metaCalls = 0;
  whatsapp.sendImage = async (to, url, caption) => {
    whatsappCall = { to, url, caption };
    return { success: true, wamid: "wamid-image-1" };
  };
  meta.sendImage = async () => {
    metaCalls += 1;
    return { success: true, wamid: null };
  };

  const result = await messaging.sendImageByUrl(
    { id: 1, channel: "whatsapp", whatsapp_number: "60123456789" },
    "https://example.test/promo.jpg",
    "Promo"
  );

  assert.deepEqual(whatsappCall, {
    to: "60123456789",
    url: "https://example.test/promo.jpg",
    caption: "Promo",
  });
  assert.equal(metaCalls, 0);
  assert.equal(result.wamid, "wamid-image-1");
});

test("WhatsApp inbound media still uses the existing WhatsApp downloadMedia function", async (t) => {
  const originalWhatsappDownload = whatsapp.downloadMedia;
  const originalMetaDownload = meta.downloadMedia;
  t.after(() => {
    whatsapp.downloadMedia = originalWhatsappDownload;
    meta.downloadMedia = originalMetaDownload;
  });

  let whatsappMediaId = null;
  let metaCalls = 0;
  whatsapp.downloadMedia = async (mediaId) => {
    whatsappMediaId = mediaId;
    return { buffer: Buffer.from("voice"), mimeType: "audio/ogg" };
  };
  meta.downloadMedia = async () => {
    metaCalls += 1;
    return null;
  };

  const media = await messaging.downloadIncomingMedia({
    channel: "whatsapp",
    mediaId: "wa-media-123",
  });

  assert.equal(whatsappMediaId, "wa-media-123");
  assert.equal(metaCalls, 0);
  assert.equal(media.mimeType, "audio/ogg");
});
