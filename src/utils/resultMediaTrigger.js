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
const { EXPLICIT_TREATMENT_INTEREST, EXPLICIT_RESULT_IMAGE_REQUEST } = require("./resultMediaPacing");
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

  const configuredDirect = resultMedia.filter((entry) =>
    normalizeServiceName(entry?.service) === target
  );
  // An explicitly disabled direct set must not fall back to a related set.
  if (configuredDirect.length > 0 && !configuredDirect.some((entry) =>
    entry?.enabled === true && normalizeResultMediaTriggerMode(entry) !== "off"
  )) return null;

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

// Additional, narrow trigger for a customer who asks about visible RESULTS
// while continuing a single treatment conversation. Not an AI/CRM/ad guess.
const OUTCOME_FOLLOWUP = /(?:会|會|能|可以|会不会|會不會|能不能|有没有|有沒有|效果|結果|结果|做完|做了).{0,24}(?:好看|漂亮|改善|变化|變化|明显|明顯|有效|见效|見效|看得出|看得到|瘦|紧致|緊緻|提升|提拉|效果|差别|差別)|(?:效果|結果|结果|好看|变化|變化).{0,12}(?:好|吗|嗎|呢|怎样|怎樣|如何|怎么样|怎麼樣|明显|明顯|有|看得到|看得出)|\b(?:will\s+(?:it|i)\s+(?:look|see|notice|improve)|(?:does|do|will|can)\s+(?:it|this)\s+(?:work|help|improve|make|show)|(?:look\s+better|visible\s+results?|see\s+results?|notice\s+a\s+difference|results?\s+(?:good|visible|noticeable))|boleh\s+(?:nampak|jadi|kurang|cantik)|nampak\s+(?:hasil|perubahan)|ada\s+(?:hasil|perubahan))\b/iu;
const NON_RESULT_OR_DECLINE = /(?:别|別|不用|不要|不想|停止|取消|退订|退訂|退费|退費|投诉|投訴|退款|不感兴趣|不感興趣|没兴趣|沒興趣|不要发|不要發|不必发|不必發|不用看|不想看|\b(?:stop|cancel|unsubscribe|opt[\s-]?out|not\s+interested|no\s+thanks|don't\s+send|do\s+not\s+send|refund|complain|appointment|address|location|opening\s+hours)\b)/iu;
const SHORT_RELATED_CONCERN = /^(?:下巴|双下巴|雙下巴|下颚线|下顎線|下颌线|脸型|臉型|脸宽|臉寬|jawline|double\s+chin|face\s+shape|小腹|腰酸|腰痛|lower\s+back|posture)[\s。.!！?？]*$/iu;

function isContextualResultOutcomeQuestion(customerText) {
  const text = String(customerText || "").normalize("NFKC").trim();
  if (!text || text.length > 160 ||
      isGreetingOrLanguageOnly(text) ||
      hasCustomerPriceEnquiry(text) ||
      isContextualAdServiceEnquiry(text) ||
      NON_RESULT_OR_DECLINE.test(text) ||
      hasClinicalMediaRisk(text)) return false;
  return EXPLICIT_RESULT_IMAGE_REQUEST.test(text) || OUTCOME_FOLLOWUP.test(text);
}

/**
 * Database evidence is DESC (latest first), from this contact only and at most
 * two hours old. The closest preceding customer-authorized named service wins.
 * A staff message, topic change, vague ack, unrelated question or two unknown
 * customer turns fails closed. No Meta ad copy or AI-selected service is used.
 */
function verifiedRecentResultTreatment({
  customerText, priorConversationRows, resultMedia, services = [], serviceAliases = [],
} = {}) {
  if (!isContextualResultOutcomeQuestion(customerText) ||
      !Array.isArray(priorConversationRows) || !priorConversationRows.length) return null;
  if (customerNamedServices(resultMedia, customerText, serviceAliases, services).length) return null;
  let customerTurns = 0;
  for (const turn of priorConversationRows.slice(0, 12)) {
    if (turn?.role === "assistant") {
      if (turn.sent_by_username ||
          /^\[Verified STAFF message\]/iu.test(String(turn.content || ""))) return null;
      continue;
    }
    if (turn?.role !== "user" || typeof turn.content !== "string" ||
        turn.media_mime_type || turn.media_url) return null;
    const text = turn.content.normalize("NFKC").trim();
    if (!text || NON_RESULT_OR_DECLINE.test(text) || hasClinicalMediaRisk(text)) return null;
    const matches = qualifiedTreatmentMentions(
      customerNamedServices(resultMedia, text, serviceAliases, services), text
    );
    if (matches.length > 1) return null;
    if (matches.length === 1) {
      const media = matchingResultMediaSet(resultMedia, matches[0]);
      return media?.triggerMode === "service_enquiry" ? matches[0] : null;
    }
    customerTurns += 1;
    if (customerTurns > 1 || !SHORT_RELATED_CONCERN.test(text)) return null;
  }
  return null;
}

async function resolveResultMediaForReplyAttempt({
  serviceQuery,
  serviceQuerySource,
  metaAdCreativeService = null,
  customerText = null,
  priorCustomerTexts = null,
  contextualResultTreatment = null,
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
  // For a verified, explicitly named primary service which only borrows
  // related proof photos, a price-only enquiry may still show those examples
  // if the primary has no price graphic. This does not authorize promotions.
  const relatedPriceProof =
    namedServices.length === 1 &&
    hasCustomerPriceEnquiry(customerText) &&
    hasCustomerServiceEnquiry(customerText) &&
    (() => {
      const relatedSet = matchingResultMediaSet(resultMedia, namedServices[0]);
      return relatedSet?.triggerMode === "service_enquiry" &&
        normalizeServiceName(relatedSet.service) !== normalizeServiceName(namedServices[0]);
    })();
  const directlyNamedTreatment = explicitServiceNamedByCustomer(
    resultMedia, customerText, serviceAliases, services
  ) || (relatedPriceProof ? namedServices[0] : null);
  const effectiveTreatment = directlyNamedTreatment || contextualResultTreatment || treatment ||
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
    : hasCustomerServiceEnquiry(customerText) || (contextualAdEnquiry && verifiedCreativeService) ||
      Boolean(contextualResultTreatment);
  if (!customerRequestedMediaContext) return skip("no_customer_service_enquiry");

  const sourceIsTrusted = SERVICE_QUERY_SOURCES.has(serviceQuerySource);
  const metaAdSourceVerified =
    serviceQuerySource !== "meta_ad" || verifiedCreativeService;
  const trustedServiceQuery =
    serviceQuery === true && sourceIsTrusted && (metaAdSourceVerified || !!directlyNamedTreatment);

  // Mismatched or unverified Meta source cannot bypass any trigger mode.
  if (serviceQuerySource === "meta_ad" && !metaAdSourceVerified &&
      !directlyNamedTreatment && !contextualResultTreatment) {
    return skip("meta_creative_conflicts_with_ai");
  }

  // Only the first-turn verified-ad case may recover missing AI structured
  // intent. Ordinary service enquiries retain the trusted one-service check.
  const verifiedAdFallback =
    resultSet.triggerMode === "service_enquiry" &&
    contextualAdEnquiry && verifiedCreativeService;
  const intentEligible =
    resultSet.triggerMode === "service_enquiry"
      ? trustedServiceQuery || verifiedAdFallback || !!directlyNamedTreatment ||
        !!contextualResultTreatment
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
    allowRelatedPriceProof: relatedPriceProof === true,
    serviceQuerySource: contextualResultTreatment ? "verified_customer_followup"
      : directlyNamedTreatment ? "customer_message"
      : verifiedAdFallback ? "meta_ad" : trustedServiceQuery ? serviceQuerySource : null,
    items: rotatedItems
      .slice(0, resultSet.autoSendCount)
      .map((item) => resolveLocalizedMedia(item, language)),
  };
}

// The existing resolver ALWAYS has first refusal. Only when the original
// trigger would SKIP for missing enquiry/service evidence may a verified
// results-related follow-up supply the missing context. Never rescue safety,
// review, disabled/off, duplicate, unknown-delivery or provider-state skips.
const CONTEXTUAL_FALLBACK_SKIP_REASONS = new Set([
  "no_verified_treatment",
  "no_customer_service_enquiry",
  "structured_service_intent_not_verified",
]);

async function resolveResultMediaForReply(options = {}) {
  let originalSkip = null;
  const primary = await resolveResultMediaForReplyAttempt({
    ...options,
    contextualResultTreatment: null,
    onSkip: (reason) => { originalSkip = reason; },
  });
  if (primary) return primary;

  const emitSkip = (reason) => {
    if (typeof options.onSkip === "function") options.onSkip(reason);
    return null;
  };
  if (!CONTEXTUAL_FALLBACK_SKIP_REASONS.has(originalSkip) ||
      !isContextualResultOutcomeQuestion(options.customerText)) {
    return emitSkip(originalSkip);
  }

  // This query is deliberately lazy: if the old logic would have sent the
  // photos, or another mandatory guard blocked them, don't even fetch context.
  let priorRows = options.priorResultContextRows;
  if (!Array.isArray(priorRows) &&
      typeof options.loadPriorResultContext === "function") {
    try {
      priorRows = await options.loadPriorResultContext();
    } catch (_err) {
      return emitSkip(originalSkip); // fail closed without changing the reply
    }
  }
  const contextualTreatment = verifiedRecentResultTreatment({
    customerText: options.customerText,
    priorConversationRows: priorRows,
    resultMedia: options.resultMedia,
    services: options.services,
    serviceAliases: options.serviceAliases,
  });
  if (!contextualTreatment) return emitSkip(originalSkip);

  let fallbackSkip = null;
  const recovered = await resolveResultMediaForReplyAttempt({
    ...options,
    contextualResultTreatment: contextualTreatment,
    onSkip: (reason) => { fallbackSkip = reason; },
  });
  if (recovered) return recovered;
  return emitSkip(fallbackSkip || originalSkip);
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
  isContextualResultOutcomeQuestion,
  verifiedRecentResultTreatment,
};
