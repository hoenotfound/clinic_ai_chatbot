const { isGreetingOrLanguageOnly } = require("./chatLanguage");
const {
  hasCustomerPriceEnquiry,
  hasCustomerServiceEnquiry,
  isContextualAdServiceEnquiry,
} = require("./customerEnquiryEvidence");
const {
  normalizeMediaTranslations,
  resolveLocalizedMedia,
} = require("./mediaLocalization");
const DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS = 7 * 24;
const RESULT_MEDIA_TRIGGER_MODES = new Set(["off", "price_only", "service_enquiry"]);
const SERVICE_QUERY_SOURCES = new Set(["customer_message", "conversation", "meta_ad"]);

function normalizeResultMediaTriggerMode(entry) {
  const configured = String(entry?.triggerMode || "").trim();
  if (RESULT_MEDIA_TRIGGER_MODES.has(configured)) return configured;
  // Backward compatibility for configs/snapshots created before triggerMode.
  return entry?.sendAfterPrice === true ? "price_only" : "off";
}

function normalizeServiceName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function matchingResultMediaSet(resultMedia, treatment) {
  const target = normalizeServiceName(treatment);
  if (!target || !Array.isArray(resultMedia)) return null;

  const matches = resultMedia.filter(
    (entry) =>
      entry &&
      entry.enabled === true &&
      normalizeResultMediaTriggerMode(entry) !== "off" &&
      normalizeServiceName(entry.service) === target
  );
  if (matches.length !== 1) return null;

  const [entry] = matches;
  const items = (Array.isArray(entry.items) ? entry.items : [])
    .filter(
      (item) =>
        item &&
        typeof item.imageUrl === "string" &&
        item.imageUrl.trim() &&
        typeof item.caption === "string" &&
        item.caption.trim()
    )
    .map((item) => {
      const translations = normalizeMediaTranslations(item.mediaTranslations);
      const { mediaTranslations: _configuredTranslations, ...baseItem } = item;
      return {
        ...baseItem,
        imageUrl: item.imageUrl.trim(),
        caption: item.caption.trim(),
        ...(Object.keys(translations).length > 0
          ? { mediaTranslations: translations }
          : {}),
      };
    });
  if (!items.length) return null;

  const configuredCount = Number(entry.autoSendCount);
  const autoSendCount =
    Number.isSafeInteger(configuredCount) && configuredCount >= 1
      ? Math.min(configuredCount, 2, items.length)
      : 1;

  return {
    ...entry,
    service: String(entry.service || "").trim(),
    triggerMode: normalizeResultMediaTriggerMode(entry),
    autoSendCount,
    items,
  };
}

/**
 * Chooses approved service-level result media after a successful AI reply.
 * Automatic proof is deliberately conservative: if any configured result image
 * for this service was accepted inside the duplicate window, do not send more.
 * Once the cooldown expires, continue with the example after the most recently
 * accepted one so larger result libraries actually rotate.
 */
function mediaIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(
    /\/(?:promo-images|api\/config\/result-media\/image)\/(\d+)(?:[/?#]|$)/
  );
  return match ? `stored:${match[1]}` : raw;
}

function itemImageUrls(item) {
  const translations = normalizeMediaTranslations(item?.mediaTranslations);
  return [...new Set([
    String(item?.imageUrl || "").trim(),
    ...Object.values(translations).map((entry) => String(entry.imageUrl || "").trim()),
  ].filter(Boolean))];
}

function rotateAfter(items, lastImageUrl) {
  if (!Array.isArray(items) || items.length === 0 || !lastImageUrl) return items;
  const lastIdentity = mediaIdentity(lastImageUrl);
  const index = items.findIndex(
    (item) => itemImageUrls(item).some((imageUrl) => mediaIdentity(imageUrl) === lastIdentity)
  );
  if (index < 0) return items;
  const start = (index + 1) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

// The repository returns the FIRST three earlier inbound customer texts.
// Three or more prior customer turns, even if the AI snapshot only shows a
// greeting, must never activate old creative. Unverified history fails closed.
function isEarlyContextualAdEnquiry({
  customerText,
  priorCustomerTexts = null,
} = {}) {
  if (!isContextualAdServiceEnquiry(customerText) ||
      !Array.isArray(priorCustomerTexts) || priorCustomerTexts.length > 2) {
    return false;
  }
  return priorCustomerTexts.every((text) => isGreetingOrLanguageOnly(text));
}

async function resolveResultMediaForReply({
  serviceQuery,
  serviceQuerySource,
  metaAdCreativeService = null,
  customerText = null,
  priorCustomerTexts = null,
  onSkip = null,
  priceQuery,
  packageQuery,
  treatment,
  flagged,
  bookingReady,
  keywordReason,
  needsAttention,
  textSendSucceeded,
  resultMedia,
  language = "en",
  contactId,
  wasMediaRecentlySent,
  getMostRecentlySentMediaUrl,
  duplicateWindowHours = DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
}) {
  // A contextual Click-to-WhatsApp question can follow a greeting or language
  // preference. Never apply this exception after a substantive customer turn,
  // and never use an ad name or an AI model guess as verification.
  const contextualAdText = isContextualAdServiceEnquiry(customerText);
  const contextualAdEnquiry = isEarlyContextualAdEnquiry({
    customerText,
    priorCustomerTexts,
  });
  const skip = (reason) => {
    if (contextualAdText && typeof onSkip === "function") onSkip(reason);
    return null;
  };
  if (
    flagged ||
    bookingReady ||
    keywordReason ||
    needsAttention ||
    textSendSucceeded !== true
  ) {
    return skip("unsafe_or_unsent_ai_reply");
  }

  // Old Meta-ad intent cannot bypass full-history verification. Preserve
  // ordinary non-ad conversations where the AI has separately confirmed the
  // treatment and the current customer turn explicitly expresses interest.
  // Generic CTWA defaults ("more info on this") still lack independent service
  // evidence and cannot unlock media through a model-only conversation flag.
  if (contextualAdText && !contextualAdEnquiry &&
      (serviceQuerySource === "meta_ad" || !hasCustomerServiceEnquiry(customerText))) {
    return skip("contextual_ad_history_unverified_or_not_early");
  }

  const effectiveTreatment = treatment || (contextualAdEnquiry ? metaAdCreativeService : null);
  if (!effectiveTreatment) return skip("no_verified_treatment");
  const resultSet = matchingResultMediaSet(resultMedia, effectiveTreatment);
  if (!resultSet) return skip("no_matching_enabled_result_media");

  const verifiedCreativeService =
    !!normalizeServiceName(metaAdCreativeService) &&
    normalizeServiceName(metaAdCreativeService) === normalizeServiceName(effectiveTreatment);

  // Generic messages cannot justify selecting images from AI guesses or
  // CRM treatment_interest. The live ad creative must verify this exact service.
  if (contextualAdEnquiry && !verifiedCreativeService) {
    return skip("meta_creative_not_verified_or_conflicts_with_ai");
  }

  // Never use a model's structured flags or Meta attribution alone: an
  // independent, current customer enquiry is mandatory.
  const customerRequestedMediaContext = resultSet.triggerMode === "price_only"
    ? hasCustomerPriceEnquiry(customerText)
    : hasCustomerServiceEnquiry(customerText) || (contextualAdEnquiry && verifiedCreativeService);
  if (!customerRequestedMediaContext) return skip("no_customer_service_enquiry");

  const sourceIsTrusted = SERVICE_QUERY_SOURCES.has(serviceQuerySource);
  const metaAdSourceVerified =
    serviceQuerySource !== "meta_ad" || verifiedCreativeService;
  const trustedServiceQuery =
    serviceQuery === true && sourceIsTrusted && metaAdSourceVerified;

  // Mismatched or unverified Meta source cannot bypass any trigger mode.
  if (serviceQuerySource === "meta_ad" && !metaAdSourceVerified) {
    return skip("meta_creative_conflicts_with_ai");
  }

  // Only the first-turn verified-ad case may recover missing AI structured
  // intent. Ordinary service enquiries retain the trusted one-service check.
  const verifiedAdFallback =
    resultSet.triggerMode === "service_enquiry" &&
    contextualAdEnquiry && verifiedCreativeService;
  const intentEligible =
    resultSet.triggerMode === "service_enquiry"
      ? trustedServiceQuery || verifiedAdFallback
      : priceQuery === true;
  if (!intentEligible) return skip("structured_service_intent_not_verified");

  if (
    typeof wasMediaRecentlySent !== "function" ||
    typeof getMostRecentlySentMediaUrl !== "function" ||
    !contactId
  ) {
    return skip("media_history_unavailable");
  }

  const allConfiguredImageUrls = [];
  for (const item of resultSet.items) {
    for (const imageUrl of itemImageUrls(item)) {
      allConfiguredImageUrls.push(imageUrl);
      const recentlySent = await wasMediaRecentlySent(
        contactId,
        imageUrl,
        duplicateWindowHours
      );
      if (recentlySent) return skip("result_media_recently_sent");
    }
  }

  const lastImageUrl = await getMostRecentlySentMediaUrl(
    contactId,
    [...new Set(allConfiguredImageUrls)]
  );
  const rotatedItems = rotateAfter(resultSet.items, lastImageUrl);

  return {
    service: resultSet.service,
    triggerMode: resultSet.triggerMode,
    serviceQuerySource: verifiedAdFallback ? "meta_ad" : trustedServiceQuery ? serviceQuerySource : null,
    items: rotatedItems
      .slice(0, resultSet.autoSendCount)
      .map((item) => resolveLocalizedMedia(item, language)),
  };
}

module.exports = {
  DEFAULT_RESULT_MEDIA_DUPLICATE_HOURS,
  RESULT_MEDIA_TRIGGER_MODES,
  SERVICE_QUERY_SOURCES,
  isEarlyContextualAdEnquiry,
  normalizeResultMediaTriggerMode,
  itemImageUrls,
  matchingResultMediaSet,
  mediaIdentity,
  rotateAfter,
  resolveResultMediaForReply,
};
