const leadAttributionRepo = require("../db/leadAttributionRepo");

const FIELD_LIMITS = Object.freeze({
  adName: 240,
  headline: 500,
  body: 1200,
  campaignName: 240,
  adsetName: 240,
  mediaType: 80,
});

function cleanContextText(value, maxLength) {
  if (value == null) return null;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeMetaAdReplyContext(row) {
  if (!row || row.source !== "meta_ads") return null;

  const context = {
    adName: cleanContextText(row.ad_name, FIELD_LIMITS.adName),
    headline: cleanContextText(row.headline, FIELD_LIMITS.headline),
    body: cleanContextText(row.body, FIELD_LIMITS.body),
    campaignName: cleanContextText(row.campaign_name, FIELD_LIMITS.campaignName),
    adsetName: cleanContextText(row.adset_name, FIELD_LIMITS.adsetName),
    mediaType: cleanContextText(row.media_type, FIELD_LIMITS.mediaType),
  };

  return Object.values(context).some(Boolean) ? context : null;
}

async function loadMetaAdReplyContext(
  contactId,
  { repo = leadAttributionRepo } = {}
) {
  const id = Number(contactId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const row = await repo.getForContactCurrentLead(id);
  return normalizeMetaAdReplyContext(row);
}

module.exports = {
  FIELD_LIMITS,
  cleanContextText,
  normalizeMetaAdReplyContext,
  loadMetaAdReplyContext,
};
