"use strict";

// Existing AI intent flags classify the customer's request. Treatment identity
// must come from customer evidence or an unambiguous verified Meta acquisition
// context; all quoted prices must come from active configured offers.
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { isFirstTrialAmountQuestion, stripFutureFollowUpPermission, hasExplicitPriceRequest, hasExplicitPackageOptionsRequest, hasFuturePromotionPermissionWithoutPrice, isStandalonePriceQuestion } = require("./customerEnquiryEvidence");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { isContinuedTreatmentPriceQuestion, resolveContinuedTreatmentPriceService,
  resolveAnsweredConcernPriceService, resolveAnsweredConcernBothContinuation,
} = require("./priceFollowUpContext");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const { getActivePromotions } = require("./activePromotion");

const RESET = /(?:换个|換個|改聊|另外想|先不聊|不聊这个|不聊這個|其他话题|其他話題|不要这个|不要這個|不想了解|\b(?:instead|rather|switch|different treatment|another treatment|not interested|stop|unsubscribe)\b)/iu;
const REFUSAL = /(?:不要(?:报价|報價|价格|價格|價錢|价钱|优惠|優惠|促销|促銷)|不想(?:了解|知道|问|問|看)?(?:一下)?(?:报价|報價|价格|價格|價錢|价钱|优惠|優惠)|不用(?:报价|報價|价格|價格)|别(?:报|報)价|\b(?:do not|don't|no)\s+(?:send|want|need)\b.{0,35}\b(?:price|promo|offer)\b)/iu;
const STAFF_PREFIX = /^\[Verified STAFF message\]/u;
const UNRELATED = /(?:停车|停車|营业|營業|开门|開門|几点|幾點|在哪|地址|分行|预约|預約|退款|取消|\b(?:parking|hours|location|address|branch|booking|appointment|refund|cancel)\b)/iu;
// Obvious non-monetary questions must not become a price enquiry just
// because a provider mistakenly sets priceQuery=true. A separate monetary
// question in the same message still qualifies.
const NON_MONETARY_ONLY = /(?:多久|多長|多长|幾分鐘|几分钟|幾小時|几小时|多少(?:时间|時間|次|回|疗程|療程)|幾次|几次|要做幾次|要做几次|\b(?:how\s+long|how\s+much\s+time|how\s+many\s+(?:sessions?|times?|treatments?)|berapa\s+(?:lama|masa|kali|sesi|jam|minit))\b)/iu;
const DEFINITE_MONEY = /(?:多少[钱錢]|[价價](?:格|钱|錢|位)|费[用]?|費用|幾[钱錢]|几[钱錢]|\b(?:price|pricing|cost|fee|harga|bayaran|rm|myr|ringgit)\b)/iu;
const STALE_SERVICE_PRICE = /(?:\b(?:old|former|previous|expired|past|promotion|promo|special|offer|discount|trial|sale|campaign|voucher)\b|旧|舊|原价|原價|優惠|优惠|折扣|特价|特價|促销|促銷|限时|限時|过期|過期|活动|活動|曾经|曾經)/iu;
const SINGLE_STANDING_PRICE = /^(?:(?:normal|regular|standard)\s+(?:price\s*)?[:：]?\s*)?(?:RM|MYR)\s*[1-9]\d{1,5}(?:\.\d{2})?(?:\s*(?:per\s+(?:session|treatment)|\/\s*(?:session|treatment)|每次|一次))?$/iu;

// Complaints about a quoted price, affordability and a customer's budget are
// not requests for another promotional graphic. A separate direct price
// question in the same message is still a current enquiry.
const PRICE_OBJECTION = /(?:[价價](?:格|錢|钱|位).{0,28}(?:太[贵貴高]|偏高|好[贵貴]|很[贵貴]|有点[贵貴]|有點[貴贵]|贵了|貴了|超出(?:我的)?[预預]算|不便宜|负担不起|負擔不起|接受不了)|(?:太[贵貴高]|好[贵貴]|很[贵貴]|贵了|貴了|超出(?:我的)?[预預]算|负担不起|負擔不起).{0,28}[价價](?:格|錢|钱|位)|[预預]算(?:是|只有|大概|大约|大約|在|不到)?\s*(?:RM|MYR)?\s*\d{2,}|(?:\b(?:price|pricing|cost|fee|harga)\b.{0,35}\b(?:too\s+(?:expensive|high)|expensive|costly|mahal|out\s+of\s+(?:my\s+)?budget|can't\s+afford|cannot\s+afford)\b)|(?:\b(?:too\s+(?:expensive|high)|expensive|costly|mahal|can't\s+afford|cannot\s+afford)\b.{0,35}\b(?:price|pricing|cost|harga)\b)|\b(?:my|our)\s+budget\b|\bbudget\s+(?:is|around|about|of|only|rm|myr)\b|(?:harga\s+mahal|mahal\s+sangat|tak\s+mampu|tidak\s+mampu|太[贵貴]|很[贵貴]|有[点點][贵貴]|[贵貴]了|超出[预預]算|too\s+expensive|too\s+costly))/iu;
const CLEAR_PRICE_QUESTION = /(?:多少[钱錢]|[几幾](?:多)?[钱錢]|[价價](?:格|錢|钱|位)\s*(?:是|多少|几多|幾多)?\s*[?？]|(?:做|来|來)?(?:一(?:次|回|趟|个|個)|1\s*(?:次|回))\s*(?:是|要|需要|收费|收費|花)?\s*(?:多少|几多|幾多)\s*[?？]?(?!\s*(?:[分钟鐘]|小时|小時|时间|時間|次|回|疗程|療程|天|日|周|週))|\bhow\s+much\b(?!\s+(?:time|long|pain|hurt|duration|recovery|sessions?))|\b(?:what(?:'s| is)?|tell\s+me|send\s+me|share|show\s+me)\b.{0,35}\b(?:price|cost|fee|harga)\b|\b(?:price|harga|berapa\s+(?:harga|bayar|ringgit|rm))\s*[?？]|\b(?:berapa\s+(?:harga|bayar|nak\s+bayar|untuk\s+(?:satu|1)\s+sesi))\b|(?:目前|现在|現在|current|latest|today).{0,20}(?:[价價](?:格|錢|钱)|多少钱|多少錢|price|cost|harga))/iu;

function isPurePriceObjection(customerText) {
  const current = String(customerText || "").trim();
  return PRICE_OBJECTION.test(current) && !CLEAR_PRICE_QUESTION.test(current);
}

// An AI flag is a classification hint, not customer permission to quote or
// automatically send media. Independently require a CURRENT request for the
// actual monetary amount (not an opinion about results, duration or value).
// The natural Malaysian Chinese/Malay forms were absent from the older
// keyword checker; retain them explicitly without accepting any 'price' noun.
const CURRENT_PRICE_AMOUNT_REQUEST =
  /(?:多少[钱錢]|[几幾](?:多)?[钱錢]|[价價](?:格|錢|钱|位)\s*(?:(?:是|要|多少|[几幾]多)\s*)?[?？]|(?:做|来|來|上)?(?:一\s*(?:次|回|趟|个|個)|1\s*(?:次|回))\s*(?:(?:要|收|花|需|是|收费|收費|费用|費用)\s*)?(?:多少|[几幾]多)(?!\s*(?:[分钟鐘]|小时|小時|时间|時間|次|回|疗程|療程|天|日|周|週))|(?:[价價](?:格|錢|钱|位)|费用|費用|收费|收費)\s*(?:是\s*)?(?:多少|[几幾]多)|(?:怎么|怎麼|如何|怎样|怎樣)\s*(?:收[费費]|算(?:[价價]|钱|錢))|\bhow\s+much\b(?!\s+(?:time|long|pain|hurt|duration|recovery|sessions?|swelling|water|weight|difference|improvement|does|do|will|would|should|can|could|must|need)\b)|\b(?:what(?:'s| is)?|tell\s+me|show\s+me|send\s+me|share|could\s+you|can\s+you)\b.{0,45}\b(?:price|cost|fee|rates?|harga|bayaran)\b|\b(?:price|pricing|cost|fees?|harga)\s*[?？]?\s*$|\b(?:berapa\s+(?:harga|nak\s+bayar|bayar|ringgit|rm|kos|caj|satu\s+sesi|sekali|untuk\s+(?:satu|1)\s+sesi)|harga\s+berapa|berapa\s+ya\s+harga)\b)/iu;
const TOPIC_SWITCH_TO_NEW_SERVICE =
  /(?:换个|換個|改聊|另外想|(?:现在|現在|这次|這次)\s*(?:想了解|想问|想問)|\b(?:instead|rather|switch|another\s+treatment|different\s+treatment)\b|\b(?:nak|mahu)\b.{0,18}\b(?:rawatan|servis)\b.{0,12}\blain\b)/iu;

// An explicitly interrogative price clause may be the second half of a
// compound Malaysian-Chinese question: "做几次呢？价钱呢？". Requiring
// the question to be ONLY an amount phrase loses an otherwise verified
// service and causes the final reply guard to contradict model intent.
// Adjectival comments ("价钱太贵了") and mere price mentions do not match.
const PRICE_QUESTION_CLAUSE =
  /(?:[价價](?:格|钱|錢|位)|收[费費]|费[用]?|費用)\s*(?:(?:是|要|大约|大概|约|約|先|呢|吗|嗎|呀|啊|多少|几多|幾多|什么|什麼|多少呢)\s*){0,5}[?？]/iu;

function hasCurrentPriceAmountRequest(customerText) {
  const current = String(customerText || "").trim();
  return CURRENT_PRICE_AMOUNT_REQUEST.test(current) ||
    PRICE_QUESTION_CLAUSE.test(current) || isFirstTrialAmountQuestion(current);
}

const BRIDGE = /(?:这个|這個|那个|那個|效果|有效|多久|时间|時間|包括|包含|套餐|配套|护理|護理|疗程|療程|调理|調理|\b(?:this|that|it|results?|effective|duration|long|include|package|session|treatment|details?|pakej|rawatan)\b)/iu;
// A customer asking for the clinic's address/hours has not switched away
// from the treatment they explicitly chose. Only a short, standalone
// administrative question can bridge ONE customer turn. Refunds, deposits,
// cancellations and different treatment topics remain hard stops.
const SHORT_LOCATION_HOURS = /^(?:(?:请问|請問|想问|想問|请发|請發|你们|你們|你家|你那边|你那邊|在哪里|在哪裡|在那|where\s+(?:are\s+you|is\s+(?:the\s+)?(?:clinic|centre|center))|what(?:'s| is)\s+(?:your|the))\s*){0,2}(?:地址|地点|地點|位置|在哪里|在哪裡|在哪|营业时间|營業時間|几点开门|幾點開門|开门时间|開門時間|几点关门|幾點關門|branch|location|address|opening\s+hours|business\s+hours|working\s+hours|hours|alamat|lokasi|waktu\s+operasi|jam\s+buka)(?:\s*(?:在哪里|在哪裡|在哪|是|呢|呀|啊|几点|幾點|多少|多少点|多少點|please|ya|ah))?[\s?？。!！]*$/iu;
const SHORT_LOCATION_QUESTION = /^(?:(?:where\s+are\s+you(?:\s+located)?|where\s+is\s+(?:your|the)\s+(?:clinic|centre|center)|what(?:'s| is)\s+your\s+(?:address|location)|where\s+to\s+find\s+you|(?:你们|你們|诊所|診所)\s*(?:在)?(?:哪里|哪裡|哪里啊|哪裡啊|在哪|在哪里|在哪裡)|在哪里|在哪裡|alamat\s+(?:di\s+mana|mana)|kat\s+mana))[\s?？。!！]*$/iu;
function isBriefLocationHoursQuestion(text) {
  const value = String(text || "").normalize("NFKC").trim();
  return value.length > 0 && value.length <= 55 &&
    !SPECIFIC_ADMIN_FEE.test(value) &&
    (SHORT_LOCATION_HOURS.test(value) || SHORT_LOCATION_QUESTION.test(value));
}

function verifiedServiceAnchor({
  customerText, conversationHistory, services, serviceAliases, modelTreatment,
}) {
  const current = String(customerText || "").trim();
  const candidates = serviceCandidates(services, serviceAliases);
  const mentions = [...new Set(findServicesInText(current, candidates))];
  const currentService = safeServiceFromCustomer(current, services, serviceAliases);
  if (mentions.length > 1 || (mentions.length && !currentService)) return null;
  if (currentService) {
    // Customer-authored, unambiguous service evidence outranks an unsupported
    // model label. The model cannot veto or invent a treatment at this boundary.
    return { treatment: currentService.name, source: "current_customer" };
  }

  // Never carry a treatment from a CRM label, an ad, or a bot suggestion.
  // Read at most two previous customer turns. A single short clinic
  // address/hours question may interrupt a customer-named service enquiry;
  // this does not authorize an ad-only or model-only treatment.
  if (current.length > 115) return null;
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  let currentSkipped = false, customerTurns = 0, bridge = false;
  for (let i = history.length - 1; i >= 0 && customerTurns < 2; i -= 1) {
    const entry = history[i];
    if (entry?.role === "assistant") {
      if (STAFF_PREFIX.test(String(entry.content || "").trim())) return null;
      continue;
    }
    if (entry?.role !== "user") continue;
    const text = String(entry.content || "").trim();
    if (!currentSkipped && text === current) { currentSkipped = true; continue; }
    if (!text || RESET.test(text) || REFUSAL.test(text) ||
        AD_NEGATED_TOPIC.test(text) || AD_BROAD_TOPIC.test(text)) return null;
    customerTurns += 1;
    const found = [...new Set(findServicesInText(text, candidates))];
    const named = safeServiceFromCustomer(text, services, serviceAliases);
    if (found.length > 1 || (found.length && !named)) return null;
    if (named) {
      // Latest independent customer choice wins, including a switch from the
      // original ad treatment; a conflicting model label is not proof.
      return { treatment: named.name, source: "recent_customer" };
    }
    if (bridge || (!BRIDGE.test(text) && !isBriefLocationHoursQuestion(text)) ||
        (UNRELATED.test(text) && !isBriefLocationHoursQuestion(text))) return null;
    bridge = true;
  }
  return null;
}


// A first-touch Meta ad can establish the initial service, but only when its
// locally verified creative or ad name identifies exactly one configured
// treatment. Do not use a CRM treatment label, free-form AI guess or stale ad
// attribution after the customer has changed or broadened the conversation.
const AD_BROAD_TOPIC = /(?:所有|全部|全套|整份|列出|价目表|價目表|还有什么|有什么(?:疗程|療程|服务|服務)|其他(?:疗程|療程|服务|服務)|\b(?:all\s+(?:the\s+)?(?:prices|treatments|services)|(?:price|pricing|cost)\s*list|which\s+(?:treatments|services)|other\s+(?:treatments|services)|senarai\s+harga)\b)/iu;

const AD_NEGATED_TOPIC = /(?:不要|不想|不考虑|不考慮|不需要|不做|不是|没兴趣|沒興趣|not interested|don.t want|do not want|tak nak|tidak mahu)/iu;
// The original ad is an acquisition hint only. After seven days a standalone
// price question needs a fresh service confirmation from the customer.
const META_AD_PRICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AD_UNRELATED_FEE = /(?:订金|訂金|定金|按金|押金|预付|預付|手续费|手續費|挂号|掛號|诊金|診金|注册|註冊|报名|報名|停车|停車|运费|運費|邮费|郵費|配送|送货|送貨|会员费|會員費|咨[询詢]|评估|評估|面诊|面診|预约|預約|取消费|取消費|\b(?:deposit|down[\s-]?payment|booking|reservation|registration|consultation|assessment|evaluation|parking|delivery|shipping|membership|cancellation|admin(?:istration)?|processing)\b)/iu;
// Keep the ad-only fallback narrow. Other price requests still follow the
// existing customer-authored service verification path.
// A customer can ask about a paid treatment and its appointment in one
// message. Do not suppress that legitimate quote just because "booking"
// appears, but still block a question about a separate administrative charge.
const SPECIFIC_ADMIN_FEE = /(?:订金|訂金|定金|按金|押金|手续费|手續費|挂号费|掛號費|诊金|診金|注册费|註冊費|报名费|報名費|停车费|停車費|运费|運費|邮费|郵費|配送费|送货费|送貨費|会员费|會員費|预约金|預約金|预约费|預約費|(?:咨询|諮詢|评估|評估|面诊|面診)(?:的)?(?:费|費|多少钱|多少錢|收费|收費)|\b(?:deposit|down[\s-]?payment|booking\s+fee|reservation\s+fee|registration\s+fee|consultation\s+fee|assessment\s+fee|evaluation\s+fee|parking\s+fee|delivery\s+fee|shipping\s+fee|membership\s+fee|cancellation\s+fee|admin(?:istration)?\s+fee|processing\s+fee)\b)/iu;
const AD_TREATMENT_PRICE_QUESTION = /^(?:(?:请问|請問|想问|想問)\s*)?(?:(?:这个|這個|这项|這項|这种|這種)\s*)?(?:做\s*)?(?:一|1)\s*(?:次|回|趟)\s*(?:(?:要|是|大概|大约|大約|收费|收費|花)\s*)?(?:多少(?:钱|錢)?|[几幾]多(?:钱|錢)?)[\s?？。!！]*$/iu;
const AD_ENGLISH_SESSION_PRICE = /^(?:how much\s+(?:is it\s+)?(?:per|for)\s+(?:(?:one|a|1)\s+)?(?:session|treatment)|(?:what(?:'s| is)?|how much is)\s+(?:the\s+)?(?:price|cost|fee)\s+(?:for|per)\s+(?:(?:one|a|1)\s+)?(?:session|treatment))[\s?？.!！]*$/iu;
const AD_MALAY_SESSION_PRICE = /^(?:berapa\s+(?:harga\s+)?(?:untuk\s+)?(?:satu|1)\s+sesi|harga\s+(?:untuk\s+)?(?:satu|1)\s+sesi\s+berapa|berapa\s+(?:untuk\s+)?sekali\s+rawatan)[\s?？.!！]*$/iu;

function isShortAdTreatmentPriceQuestion(text) {
  const current = String(text || "").normalize("NFKC").trim();
  if (!current || current.length > 80 || AD_BROAD_TOPIC.test(current) ||
      AD_UNRELATED_FEE.test(current)) return false;
  // Use the same strict monetary intent evidence as the final decision.
  // Otherwise "什么价钱呢？" can be priced from a verified customer service,
  // but not from the equally verified current ad for that service.
  // A price objection, free assessment fee or broad catalogue enquiry does
  // not become a treatment-price question merely by mentioning "价钱".
  return isStandalonePriceQuestion(current) ||
    AD_TREATMENT_PRICE_QUESTION.test(current) ||
    AD_ENGLISH_SESSION_PRICE.test(current) ||
    AD_MALAY_SESSION_PRICE.test(current) ||
    (hasCurrentPriceAmountRequest(current) &&
      hasExplicitPriceRequest(current) &&
      !isPurePriceObjection(current) && !REFUSAL.test(current) &&
      !RESET.test(current));
}

function verifiedMetaAdPriceAnchor({
  customerText, conversationHistory, services, serviceAliases, modelTreatment,
  metaAdContext, now = Date.now(),
}) {
  if (!metaAdContext || !["creative", "ad_name"].includes(metaAdContext.serviceHintSource)) return null;
  const adService = (services || []).filter((service) =>
    String(service?.name || "").trim() === metaAdContext.serviceHint
  );
  if (adService.length !== 1) return null;
  const name = adService[0].name;
  const attributedAtMs = Date.parse(String(metaAdContext.attributedAt || ""));
  if (!Number.isFinite(attributedAtMs) || !Number.isFinite(now) ||
      attributedAtMs > now || now - attributedAtMs > META_AD_PRICE_MAX_AGE_MS) return null;

  const current = String(customerText || "").trim();
  const candidates = serviceCandidates(services, serviceAliases);
  // Ad-only context is for short contextual monetary enquiries, not for an
  // unrequested price, all-treatment price list, or a competing named service.
  if (!isShortAdTreatmentPriceQuestion(current) ||
      UNRELATED.test(current) ||
      findServicesInText(current, candidates).length > 0) return null;

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  let skippedCurrent = false;
  let previousCustomerTurns = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role === "assistant") {
      if (STAFF_PREFIX.test(String(entry.content || "").trim())) return null;
      continue;
    }
    if (entry?.role !== "user") continue;
    const prior = String(entry.content || "").trim();
    if (!skippedCurrent && prior === current) {
      skippedCurrent = true;
      continue;
    }
    previousCustomerTurns += 1;
    // This is an acquisition hint, not a permanent conversation default.
    if (previousCustomerTurns > 4 || !prior || RESET.test(prior) ||
        REFUSAL.test(prior) || AD_BROAD_TOPIC.test(prior) ||
        AD_NEGATED_TOPIC.test(prior)) return null;
    const mentions = [...new Set(findServicesInText(prior, candidates))];
    if (mentions.length > 1 || (mentions.length === 1 && mentions[0] !== name)) return null;
    // Reject ambiguous service mentions or negated references even when they
    // happen to contain the advertised service name.
    if (mentions.length && !safeServiceFromCustomer(prior, services, serviceAliases)) return null;
  }
  return { treatment: name, source: "meta_ad" };
}

function resolveAiPricingDecision({
  priceQuery = false, packageQuery = false, treatment = null,
  customerText, conversationHistory = [], services = [],
  serviceAliases = [], promotions = [], allowOfferEnquiries = false,
  complimentaryAssessmentExperienceEnabled = false, metaAdContext = null,
  now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  const explicitAmount = hasCurrentPriceAmountRequest(current);
  const explicitOptions = hasExplicitPackageOptionsRequest(current);
  const currentNamedService = safeServiceFromCustomer(current, services, serviceAliases);
  // A new, explicitly named treatment plus a CURRENT pricing question is
  // permitted after a topic switch. A reset without that evidence still
  // invalidates any older service or package context; stop/unsubscribe and
  // treatment refusal never become pricing authorization.
  const validNewTreatmentSwitch = TOPIC_SWITCH_TO_NEW_SERVICE.test(current) &&
    Boolean(currentNamedService) && (explicitAmount || explicitOptions);
  // Deposit/consultation/booking fees are not paid treatment prices, even
  // when the customer explicitly names a treatment or a model flags pricing.
  if (!current || SPECIFIC_ADMIN_FEE.test(current) ||
      (RESET.test(current) && !validNewTreatmentSwitch) ||
      /\b(?:stop|unsubscribe)\b|退订|退訂/iu.test(current) ||
      REFUSAL.test(current) ||
      hasClinicalMediaRisk(current) ||
      isPurePriceObjection(current) ||
      (NON_MONETARY_ONLY.test(current) && !DEFINITE_MONEY.test(current)) ||
      isComplimentaryAssessmentFeeQuestion(
        current, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;

  const concernContinuation = resolveAnsweredConcernPriceService({
    customerText: current, conversationHistory, services, serviceAliases, now,
  });
  const bothContinuation = resolveAnsweredConcernBothContinuation({
    customerText: current, conversationHistory, services, serviceAliases, now,
  });
  const clarifiedPriceService = resolveClarifiedPriceService({
    customerText: current, conversationHistory, services, serviceAliases,
  });
  // Model intent alone must never turn a normal treatment question into an
  // unsolicited graphic. Clear keywords retain deterministic recovery if
  // Gemini misses them; natural cost wording still works when Gemini sees it.
  const monetary = Boolean(clarifiedPriceService || concernContinuation || bothContinuation) ||
    (explicitAmount && (priceQuery === true || hasExplicitPriceRequest(current))) ||
    (isStandalonePriceQuestion(current) && priceQuery === true) ||
    (isContinuedTreatmentPriceQuestion(current) && hasExplicitPriceRequest(current));
  const type = monetary ? "price" :
    packageQuery === true && allowOfferEnquiries && explicitOptions
      ? "package_options" : null;
  if (!type) return null;
  const stripped = stripFutureFollowUpPermission(current);
  if (stripped.hasFuturePermission && !hasExplicitPriceRequest(stripped.text)) return null;

  const continued = type === "price" ? resolveContinuedTreatmentPriceService({
    customerText: current, conversationHistory, services, serviceAliases, promotions,
  }) : null;
  const anchor = continued
    ? { treatment: continued.name, source: "continued_customer" }
    : concernContinuation || bothContinuation
      ? { treatment: (concernContinuation || bothContinuation).name,
          source: bothContinuation ? "customer_concern_both" : "customer_concern_continuation" }
    : verifiedServiceAnchor({
        customerText: current, conversationHistory, services, serviceAliases,
        modelTreatment: treatment,
      }) || verifiedMetaAdPriceAnchor({
        customerText: current, conversationHistory, services, serviceAliases,
        modelTreatment: treatment, metaAdContext, now,
      });
  if (!anchor || (clarifiedPriceService &&
      clarifiedPriceService !== anchor.treatment)) return null;

  // A single decision supplies the same package choices and amounts to both
  // the text formatter and the optional media selector. Missing/conflicting
  // prices are recorded as null and must never authorize promo media.
  const prices = verifiedPricesForService(
    anchor.treatment, promotions, current, conversationHistory,
    { clarifiedPriceService, allowTextOnlyOffers: true }
  );
  // Some clients configure prices directly on SERVICES without promotions.
  // Reuse that verified service text only when there is no active offer for
  // this treatment. A conflicting/uncertain active offer must fail closed.
  const activeOffer = getActivePromotions(promotions).some(p => p.linkedService === anchor.treatment);
  const rawServicePrice = !activeOffer
    ? services.find(s => s.name === anchor.treatment)?.priceRange : null;
  // SERVICE.priceRange may contain expired marketing copy or ambiguous ranges.
  // Only a single explicitly standing MYR price can be quoted as a fallback.
  const servicePrice = typeof rawServicePrice === "string" &&
    rawServicePrice.trim().length <= 100 &&
    !STALE_SERVICE_PRICE.test(rawServicePrice) &&
    SINGLE_STANDING_PRICE.test(rawServicePrice.trim())
      ? rawServicePrice.trim() : null;
  return Object.freeze({
    type, treatment: anchor.treatment, source: anchor.source,
    clarifiedPriceService, prices, servicePrice,
  });
}

// Use the same customer-authored evidence at the outbound text boundary as
// at the optional promotion decision. Never ask for pricing clarification just
// because a model wrongly returned priceQuery=true on a service question.
function hasCustomerRequestedPriceReply({
  customerText, pricingDecision = null,
} = {}) {
  const current = String(customerText || "").trim();
  return Boolean(current) &&
    !hasFuturePromotionPermissionWithoutPrice(current) &&
    !isPurePriceObjection(current) &&
    (hasCurrentPriceAmountRequest(current) ||
      (isContinuedTreatmentPriceQuestion(current) && hasExplicitPriceRequest(current)) ||
      Boolean(pricingDecision?.clarifiedPriceService) ||
      pricingDecision?.type === "package_options");
}

// Compatibility alias for existing imports in downstream tests.
module.exports = { resolveAiPricingDecision, verifiedServiceAnchor, isPurePriceObjection, hasCurrentPriceAmountRequest, hasCustomerRequestedPriceReply };
