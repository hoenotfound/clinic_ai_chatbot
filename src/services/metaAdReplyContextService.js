const leadAttributionRepo = require("../db/leadAttributionRepo");

const FIELD_LIMITS = Object.freeze({
  adName: 240,
  headline: 500,
  body: 1200,
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

  const headline = cleanContextText(row.headline, FIELD_LIMITS.headline);
  const body = cleanContextText(row.body, FIELD_LIMITS.body);

  // Creative copy is the strongest customer-intent signal. Internal hierarchy
  // names (campaign/ad set) are analytics metadata and should never influence
  // the sales reply. Ad name is only a fallback when Meta did not provide any
  // useful creative text for the referral.
  if (headline || body) {
    return {
      headline,
      body,
      adName: null,
    };
  }

  const adName = cleanContextText(row.ad_name, FIELD_LIMITS.adName);
  return adName
    ? { headline: null, body: null, adName }
    : null;
}

function hasMetaAdCreativeContext(context) {
  if (!context || typeof context !== "object") return false;
  return Boolean(
    cleanContextText(context.headline, FIELD_LIMITS.headline)
    || cleanContextText(context.body, FIELD_LIMITS.body)
  );
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
  hasMetaAdCreativeContext,
  normalizeMetaAdReplyContext,
  loadMetaAdReplyContext,
};
