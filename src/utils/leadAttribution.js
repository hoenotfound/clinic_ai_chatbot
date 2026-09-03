const SOURCE_LABELS = Object.freeze({
  meta_ads: "Meta Ads",
  meta_post: "Meta post",
  facebook_referral: "Facebook referral",
  instagram_referral: "Instagram referral",
  facebook_organic: "Facebook organic",
  instagram_organic: "Instagram organic",
  whatsapp_unattributed: "WhatsApp direct / untracked",
});

function clean(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizedChannel(channel) {
  return ["whatsapp", "facebook", "instagram"].includes(channel)
    ? channel
    : "whatsapp";
}

function defaultSourceForChannel(channel) {
  if (channel === "facebook") return "facebook_organic";
  if (channel === "instagram") return "instagram_organic";
  return "whatsapp_unattributed";
}

function sourceFromReferral(channel, referral = {}) {
  const sourceType = clean(referral.sourceType)?.toLowerCase();
  const referralSource = clean(referral.referralSource)?.toUpperCase();
  const adId = clean(referral.adId);

  if (adId || sourceType === "ad" || referralSource === "ADS") return "meta_ads";
  if (sourceType === "post") return "meta_post";
  if (channel === "facebook" && referralSource) return "facebook_referral";
  if (channel === "instagram" && referralSource) return "instagram_referral";
  return defaultSourceForChannel(channel);
}

function normalizeAttribution(channel, referral = null) {
  const normalized = normalizedChannel(channel);
  if (!referral || typeof referral !== "object") {
    return {
      source: defaultSourceForChannel(normalized),
      sourceLabel: SOURCE_LABELS[defaultSourceForChannel(normalized)],
      platform: normalized === "whatsapp" ? "whatsapp" : "meta",
      channel: normalized,
      adId: null,
      sourceId: null,
      sourceType: null,
      sourceUrl: null,
      referralRef: null,
      referralSource: null,
      referralType: null,
      ctwaClid: null,
      headline: null,
      body: null,
      mediaType: null,
      mediaUrl: null,
      campaignId: null,
      campaignName: null,
      adsetId: null,
      adsetName: null,
      adName: null,
      rawReferral: null,
    };
  }

  const sourceId = clean(referral.sourceId ?? referral.source_id);
  const sourceType = clean(referral.sourceType ?? referral.source_type);
  const referralSource = clean(referral.referralSource ?? referral.source);
  const explicitAdId = clean(
    referral.adId ?? referral.ad_id ?? referral.adsContextData?.ad_id ?? referral.ads_context_data?.ad_id
  );
  const adId = explicitAdId || (sourceType?.toLowerCase() === "ad" ? sourceId : null);
  const source = sourceFromReferral(normalized, {
    adId,
    sourceType,
    referralSource,
  });

  const mediaUrl = clean(
    referral.mediaUrl ??
      referral.imageUrl ?? referral.image_url ??
      referral.videoUrl ?? referral.video_url ??
      referral.thumbnailUrl ?? referral.thumbnail_url
  );

  return {
    source,
    sourceLabel: SOURCE_LABELS[source] || source,
    platform: "meta",
    channel: normalized,
    adId,
    sourceId,
    sourceType,
    sourceUrl: clean(referral.sourceUrl ?? referral.source_url),
    referralRef: clean(referral.referralRef ?? referral.ref),
    referralSource,
    referralType: clean(referral.referralType ?? referral.type),
    ctwaClid: clean(referral.ctwaClid ?? referral.ctwa_clid),
    headline: clean(referral.headline ?? referral.ad_title),
    body: clean(referral.body ?? referral.ad_body),
    mediaType: clean(referral.mediaType ?? referral.media_type),
    mediaUrl,
    campaignId: clean(referral.campaignId ?? referral.campaign_id),
    campaignName: clean(referral.campaignName ?? referral.campaign_name),
    adsetId: clean(referral.adsetId ?? referral.adset_id),
    adsetName: clean(referral.adsetName ?? referral.adset_name),
    adName: clean(referral.adName ?? referral.ad_name),
    rawReferral: referral,
  };
}

function normalizeWhatsAppReferral(referral) {
  return normalizeAttribution("whatsapp", referral);
}

function normalizeSocialReferral(channel, referral) {
  return normalizeAttribution(channel, referral);
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || "Unknown";
}

module.exports = {
  SOURCE_LABELS,
  defaultSourceForChannel,
  normalizeAttribution,
  normalizeWhatsAppReferral,
  normalizeSocialReferral,
  sourceLabel,
};