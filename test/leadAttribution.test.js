const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeAttribution,
  normalizeWhatsAppReferral,
  normalizeSocialReferral,
} = require("../src/utils/leadAttribution");
const {
  createLeadAttributionService,
} = require("../src/services/leadAttributionService");

test("normalizes Click-to-WhatsApp ad referral into exact Meta ad attribution", () => {
  const attribution = normalizeWhatsAppReferral({
    source_url: "https://fb.me/ctwa",
    source_id: "120210000001234",
    source_type: "ad",
    headline: "HIFU Buy 1 Free 1",
    body: "From RM1,288",
    ctwa_clid: "ARandomClickId",
    media_type: "image",
    image_url: "https://example.com/ad.jpg",
  });

  assert.equal(attribution.source, "meta_ads");
  assert.equal(attribution.channel, "whatsapp");
  assert.equal(attribution.platform, "meta");
  assert.equal(attribution.adId, "120210000001234");
  assert.equal(attribution.sourceId, "120210000001234");
  assert.equal(attribution.sourceType, "ad");
  assert.equal(attribution.ctwaClid, "ARandomClickId");
  assert.equal(attribution.headline, "HIFU Buy 1 Free 1");
  assert.equal(attribution.mediaUrl, "https://example.com/ad.jpg");
});

test("does not misclassify a WhatsApp post referral as an ad", () => {
  const attribution = normalizeWhatsAppReferral({
    source_type: "post",
    source_id: "998877",
    headline: "Clinic post",
  });

  assert.equal(attribution.source, "meta_post");
  assert.equal(attribution.adId, null);
  assert.equal(attribution.sourceId, "998877");
});

test("classifies untracked WhatsApp and organic social sources", () => {
  assert.equal(normalizeAttribution("whatsapp", null).source, "whatsapp_unattributed");
  assert.equal(normalizeAttribution("facebook", null).source, "facebook_organic");
  assert.equal(normalizeAttribution("instagram", null).source, "instagram_organic");
});

test("normalizes Facebook or Instagram ADS referrals with explicit ad id", () => {
  const attribution = normalizeSocialReferral("instagram", {
    source: "ADS",
    type: "OPEN_THREAD",
    ref: "hifu-september",
    ad_id: "120299999900001",
  });

  assert.equal(attribution.source, "meta_ads");
  assert.equal(attribution.channel, "instagram");
  assert.equal(attribution.adId, "120299999900001");
  assert.equal(attribution.referralRef, "hifu-september");
  assert.equal(attribution.referralType, "OPEN_THREAD");
});

test("keeps non-ad Instagram referral separate from organic direct messages", () => {
  const attribution = normalizeSocialReferral("instagram", {
    source: "SHORTLINK",
    type: "OPEN_THREAD",
    ref: "bio-link",
  });

  assert.equal(attribution.source, "instagram_referral");
  assert.equal(attribution.adId, null);
});

test("pending social referral is consumed by the next real inbound message", async () => {
  const calls = [];
  const pending = new Map();
  const repo = {
    async savePending(channel, externalUserId, attribution) {
      calls.push(["savePending", channel, externalUserId]);
      pending.set(`${channel}:${externalUserId}`, attribution);
    },
    async takePending(channel, externalUserId) {
      calls.push(["takePending", channel, externalUserId]);
      const key = `${channel}:${externalUserId}`;
      const value = pending.get(key) || null;
      pending.delete(key);
      return value;
    },
    async createFirstTouch(payload) {
      calls.push(["createFirstTouch", payload]);
      return payload;
    },
  };
  const service = createLeadAttributionService(repo);
  const referral = normalizeSocialReferral("facebook", {
    source: "ADS",
    ad_id: "123456",
    type: "OPEN_THREAD",
  });

  await service.rememberPendingReferral({
    attributionOnly: true,
    channel: "facebook",
    from: "psid-1",
    attribution: referral,
  });

  const result = await service.captureForInbound({
    lead: { id: 44 },
    firstMessageId: 900,
    incoming: {
      channel: "facebook",
      from: "psid-1",
      text: "hi",
    },
  });

  assert.equal(result.attribution.source, "meta_ads");
  assert.equal(result.attribution.adId, "123456");
  assert.deepEqual(calls.map((call) => call[0]), [
    "savePending",
    "takePending",
    "createFirstTouch",
  ]);
});

test("can consume an unused pending social referral without creating attribution", async () => {
  const calls = [];
  const repo = {
    async takePending(channel, externalUserId) {
      calls.push([channel, externalUserId]);
      return { source: "meta_ads", adId: "old-click" };
    },
  };
  const service = createLeadAttributionService(repo);
  const result = await service.consumePendingForInbound({
    channel: "instagram",
    from: "igsid-old-lead",
  });

  assert.equal(result.adId, "old-click");
  assert.deepEqual(calls, [["instagram", "igsid-old-lead"]]);
});
