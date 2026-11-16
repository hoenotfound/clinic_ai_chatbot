"use strict";

const { detectExplicitLanguagePreference } = require("./chatLanguage");
const { getActivePromotions, promotionPackages } = require("./activePromotion");
const { configuredFirstReplyImage } = require("./neutroBreastRm68Campaign");

// Only inspect customer turns AFTER the original image-triggering inbound.
// An old Chinese ad prefill must never overrule a newer explicit English request.
async function latestQueuedLanguagePreference(database, contactId, inboundMessageId) {
  const response = await database.query(
    `SELECT newer.content
       FROM messages newer
       JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=$1
      WHERE newer.contact_id=$1 AND newer.role='user'
        AND newer.media_url IS NULL AND newer.media_mime_type IS NULL
        AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
      ORDER BY newer.created_at DESC,newer.id DESC LIMIT 8`,
    [contactId, inboundMessageId]
  );
  for (const row of response.rows || []) {
    const language = detectExplicitLanguagePreference(row.content);
    if (language) return language;
  }
  return null;
}

function containsUrl(item, url) {
  return item && (
    item.imageUrl === url ||
    ["en", "ms", "zh"].some(language =>
      item.mediaTranslations?.[language]?.imageUrl === url)
  );
}

// Never invent translated copy. If the customer switched languages after
// enqueue, use the operator-approved localized caption and image, where
// configured. A caption-only translation can accompany the original approved
// Before & After photo; absent any translation, skip optional media.
function resolveQueuedMediaLanguage({
  imageUrl, caption = "", kind, language = null, config, now = new Date(),
} = {}) {
  if (!language) return { imageUrl, caption };
  if (!config || typeof config !== "object") return null;
  let items = [];
  if (kind === "result") {
    items = (Array.isArray(config.resultMedia) ? config.resultMedia : [])
      .filter(group => group?.enabled === true &&
        String(group.triggerMode || "off") !== "off")
      .flatMap(group => Array.isArray(group.items) ? group.items : []);
  } else if (kind === "promotion") {
    items = getActivePromotions(config.promotions, now)
      .filter(promotion => promotion?.enabled !== false)
      .flatMap(promotion => promotionPackages(promotion));
    // A fixed campaign image has no configured translated equivalent.
    if (configuredFirstReplyImage({
      config, businessName: config.businessName, now,
    }) === imageUrl && !items.some(item => containsUrl(item, imageUrl))) {
      return null;
    }
  } else {
    return null;
  }
  const source = items.find(item => containsUrl(item, imageUrl));
  if (!source) return null;
  const translated = source.mediaTranslations?.[language];
  const imageTranslation = String(translated?.imageUrl || "").trim();
  const captionTranslation = typeof translated?.caption === "string"
    ? translated.caption.trim() : "";
  if (!imageTranslation && !captionTranslation) return null;
  const translatedImageUrl = imageTranslation || imageUrl;
  const translatedCaption = captionTranslation ||
    String(source.caption || "").trim();
  // A selected English image can retain a base caption only if that caption
  // is not Chinese. Otherwise send no caption rather than a mismatched one.
  const safeCaption = language !== "zh" &&
    /[\u3400-\u4dbf\u4e00-\u9fff]/u.test(translatedCaption)
    ? "" : translatedCaption;
  return { imageUrl: translatedImageUrl, caption: safeCaption };
}

module.exports = { latestQueuedLanguagePreference, resolveQueuedMediaLanguage };
