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
const { EXPLICIT_TREATMENT_INTEREST } = require("./resultMediaPacing");
const { termSpans, pruneCoveredServiceMentions } = require("./serviceMentionResolution");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
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

// Consider every configured treatment named by the customer before trusting
// model-selected intent. Configured aliases are not ad or CRM guesses.
function customerNamedServices(resultMedia, customerText, serviceAliases = [], services = []) {
  const current = String(customerText || "");
  if (!current.trim()) return [];

  const normal = (value) => String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const compactText = normal(current);
  const matchTerm = (rawTerm) => {
    const term = normal(rawTerm);
    if (term.length < 2) return false;
    // Short Latin aliases, including 3D, cannot match inside product codes.
    if (/^[a-z0-9]{2,4}$/.test(term)) {
      const escaped = term.replace(/([.*+?^$()|[\]{}\\])/g, "\\$1");
      return new RegExp("(^|[^a-z0-9])" + escaped + "(?=$|[^a-z0-9])", "iu")
        .test(current.normalize("NFKC").toLocaleLowerCase());
    }
    return compactText.includes(term);
  };

  const names = new Map();
  for (const entry of Array.isArray(resultMedia) ? resultMedia : []) {
    if (entry?.service) names.set(normal(entry.service), String(entry.service).trim());
  }
  for (const entry of Array.isArray(services) ? services : []) {
    if (entry?.name) names.set(normal(entry.name), String(entry.name).trim());
  }
  const matches = new Map();
  const addMatch = (key, term) => {
    if (!matchTerm(term)) return;
    const spans = termSpans(compactText, normal(term));
    if (!spans.length) return;
    if (!matches.has(key)) matches.set(key, { name: names.get(key), spans: [] });
    matches.get(key).spans.push(...spans);
  };
  for (const [key, name] of names) addMatch(key, name);
  for (const entry of Array.isArray(serviceAliases) ? serviceAliases : []) {
    const key = normal(entry?.officialService);
    if (!names.has(key)) continue;
    for (const term of String(entry.alias || "").split(/[,/|;，、]+/u)) {
      addMatch(key, term.trim());
    }
  }
  // An exact "小颜整骨" alias covers the generic "整骨" alias.
  // But "整骨和小颜整骨" still names two distinct treatments.
  return pruneCoveredServiceMentions([...matches.values()])
    .map(({ name }) => name);
}

// A postpartum qualifier can describe why the customer wants *pelvic*
// treatment. It is not a separate request for the "产后调理" service.
// Comparisons and two distinct treatment names are still ambiguous.
function qualifiedTreatmentMentions(namedServices, customerText) {
  const names = Array.isArray(namedServices) ? namedServices : [];
  if (names.length !== 2) return names;
  const normalized = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
  const postpartum = names.find((name) => /^(?:产后|產後)(?:调理|調理)|^postpartum(?:\s+(?:care|recovery|treatment))?$/iu.test(normalized(name)));
  const pelvic = names.find((name) => /骨盆|骨盘|骨盤|\bpelvi[cs]\b/iu.test(normalized(name)));
  const text = String(customerText || "");
  if (!postpartum || !pelvic ||
      !/(?:产后|產後)\s*(?:的)?\s*(?:骨盆|骨盘|骨盤)|\b(?:postpartum|postnatal)\s+(?:pelvic|pelvis)\b/iu.test(text) ||
      /(?:产后调理|產後調理)|(?:分别|分別|比较|比較|区别|區別|差别|差別|哪个|哪個|两种|兩種|\b(?:or|versus|vs|compare|comparison|difference|better|atau|beza)\b)/iu.test(text)) {
    return names;
  }
  return [pelvic];
}

function explicitServiceNamedByCustomer(
  resultMedia, customerText, serviceAliases = [], services = []
) {
  const current = String(customerText || "");
  // Admin questions can mention a service without asking for examples.
  if (/(?:地址|在哪[里裡]|营业时间|營業時間|停车|停車|分行|分店|\b(?:address|location|opening hours?|parking|branch(?:es)?|alamat|lokasi|cawangan)\b)/iu.test(current)) {
    return null;
  }
  // An otherwise bare osteopathy service name is itself an enquiry.
  // It still needs one unambiguous configured alias and an enabled media set.
  const bareOsteopathyEnquiry =
    /^(?:(?:你好|hi|hello|嗨)[\s～~,，.!！。]*)?(?:整骨|全身整骨|中医徒手整骨)[\s?？.!！。]*$/iu.test(current.trim());
  if ((!EXPLICIT_TREATMENT_INTEREST.test(current) && !bareOsteopathyEnquiry) ||
      !hasCustomerServiceEnquiry(current)) return null;
  const matches = qualifiedTreatmentMentions(
    customerNamedServices(resultMedia, current, serviceAliases, services), current
  );
  if (matches.length !== 1) return null;
  return matchingResultMediaSet(resultMedia, matches[0]) ? matches[0] : null;
}

function matchingResultMediaSet(resultMedia, treatment) {
  const target = normalizeServiceName(treatment);
  if (!target || !Array.isArray(resultMedia)) return null;

  const eligible = resultMedia.filter(
    (entry) => entry?.enabled === true &&
      normalizeResultMediaTriggerMode(entry) !== "off"
  );
  // A configured service can share *informational result examples* from one
  // related treatment, without inheriting that treatment's packages or prices.
  // Exact media always wins. Ambiguous relationships fail closed.
  const direct = eligible.filter((entry) =>
    normalizeServiceName(entry.service) === target
  );
  if (direct.length > 1) return null;
  const related = direct.length ? [] : eligible.filter((entry) =>
    normalizeResultMediaTriggerMode(entry) === "service_enquiry" &&
    Array.isArray(entry.relatedServices) &&
    entry.relatedServices.some((name) => normalizeServiceName(name) === target)
  );
  const matches = direct.length ? direct : related;
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
  serviceAliases = [],
  services = [],
  language = "en",
  contactId,
  wasMediaRecentlySent,
  hasUnconfirmedMediaDelivery,
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
    if (typeof onSkip === "function") onSkip(reason);
    return null;
  };
  if (hasClinicalMediaRisk(customerText)) return skip("clinical_media_safety");
  if (needsAttention) return skip("staff_review_pending");
  if (flagged || bookingReady || keywordReason || textSendSucceeded !== true) {
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

  const namedServices = qualifiedTreatmentMentions(
    customerNamedServices(resultMedia, customerText, serviceAliases, services), customerText
  );
  if (namedServices.length > 1) return skip("multiple_treatments_ambiguous");
  const directlyNamedTreatment = explicitServiceNamedByCustomer(
    resultMedia, customerText, serviceAliases, services
  );
  const effectiveTreatment = directlyNamedTreatment || treatment ||
    (contextualAdEnquiry ? metaAdCreativeService : null);
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
    serviceQuery === true && sourceIsTrusted && (metaAdSourceVerified || !!directlyNamedTreatment);

  // Mismatched or unverified Meta source cannot bypass any trigger mode.
  if (serviceQuerySource === "meta_ad" && !metaAdSourceVerified && !directlyNamedTreatment) {
    return skip("meta_creative_conflicts_with_ai");
  }

  // Only the first-turn verified-ad case may recover missing AI structured
  // intent. Ordinary service enquiries retain the trusted one-service check.
  const verifiedAdFallback =
    resultSet.triggerMode === "service_enquiry" &&
    contextualAdEnquiry && verifiedCreativeService;
  const intentEligible =
    resultSet.triggerMode === "service_enquiry"
      ? trustedServiceQuery || verifiedAdFallback || !!directlyNamedTreatment
      : priceQuery === true;
  if (!intentEligible) return skip("structured_service_intent_not_verified");

  if (
    typeof wasMediaRecentlySent !== "function" ||
    typeof hasUnconfirmedMediaDelivery !== "function" ||
    typeof getMostRecentlySentMediaUrl !== "function" ||
    !contactId
  ) {
    return skip("media_history_unavailable");
  }

  const allConfiguredImageUrls = [];
  for (const item of resultSet.items) {
    for (const imageUrl of itemImageUrls(item)) {
      allConfiguredImageUrls.push(imageUrl);
      // Unknown or in-flight delivery can be accepted by Meta without a
      // durable provider receipt. Never retry before staff reconciliation,
      // including when the ordinary 168-hour duplicate window has elapsed.
      if (await hasUnconfirmedMediaDelivery(contactId, imageUrl)) {
        return skip("result_media_delivery_unconfirmed");
      }
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
    serviceQuerySource: directlyNamedTreatment ? "customer_message"
      : verifiedAdFallback ? "meta_ad" : trustedServiceQuery ? serviceQuerySource : null,
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
  explicitServiceNamedByCustomer,
  customerNamedServices,
  qualifiedTreatmentMentions,
  mediaIdentity,
  rotateAfter,
  resolveResultMediaForReply,
};
