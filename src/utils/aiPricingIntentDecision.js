"use strict";

// Existing AI intent flags classify the customer's request. Treatment identity
// must come from customer evidence or an unambiguous verified Meta acquisition
// context; all quoted prices must come from active configured offers.
const { safeServiceFromCustomer, hasTreatmentPriceContent } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { isFirstTrialAmountQuestion, stripFutureFollowUpPermission, hasExplicitPriceRequest, hasExplicitPackageOptionsRequest, hasFuturePromotionPermissionWithoutPrice, isStandalonePriceQuestion, isContextualAdServiceEnquiry, LOCAL_WHATSAPP_PRICE } = require("./customerEnquiryEvidence");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isGreetingOrLanguageOnly } = require("./chatLanguage");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { isContinuedTreatmentPriceQuestion, resolveContinuedTreatmentPriceService,
  resolveAnsweredConcernPriceService, resolveAnsweredConcernBothContinuation,
  isRecentPricingThread, isVerifiedStaffTurn, pricingMessageText,
  assistantIntroducesCompetingPaidService,
} = require("./priceFollowUpContext");
const { verifiedPricesForService, staffQuoteMatchesConfiguredPrice } = require("./verifiedPriceReply");
const { getActivePromotions, promotionPackages, findMentionedPromotionPackages } = require("./activePromotion");
const { matchingMetaAdCreativeServices } = require("../services/metaAdReplyContextService");
const { resolveIndependentRefusalPriceRequest, hasCustomerRefusedPriceQuote, hasScopedServiceCorrection } = require("./independentRefusalPriceRequest");
const { resolveEstablishedTreatmentPrice } = require("./priceConversationRecovery");
const { resolveStaffResultPriceContext } = require("./neutroStaffResultPriceContext");
const { resolveCurrentOfferService, isCurrentOfferEnquiry, currentOfferRequestText } = require("./currentOfferEnquiry");

const RESET = /(?:换个|換個|改聊|另外想|先不聊|不聊这个|不聊這個|其他话题|其他話題|不要这个|不要這個|不想了解|\b(?:instead|rather|switch|different treatment|another treatment|not interested|stop|unsubscribe)\b)/iu;
const REFUSAL = /(?:不要(?:报价|報價|价格|價格|價錢|价钱|优惠|優惠|促销|促銷)|不想(?:了解|知道|问|問|看)?(?:一下)?(?:报价|報價|价格|價格|價錢|价钱|优惠|優惠)|不用(?:报价|報價|价格|價格)|不需要(?:报价|報價|价格|價格|價錢|价钱)|别(?:报|報)价|\b(?:do not|don't|no)\s+(?:send|want|need)\b.{0,35}\b(?:price|promo|offer)\b)/iu;
const STAFF_PREFIX = /^\[Verified STAFF message\]/u;
const UNRELATED = /(?:停车|停車|营业|營業|开门|開門|几点|幾點|在哪|地址|分行|预约|預約|退款|取消|\b(?:parking|hours|location|address|branch|booking|appointment|refund|cancel)\b)/iu;
// Obvious non-monetary questions must not become a price enquiry just
// because a provider mistakenly sets priceQuery=true. A separate monetary
// question in the same message still qualifies.
const NON_MONETARY_ONLY = /(?:多久|多長|多长|幾分鐘|几分钟|幾小時|几小时|多少(?:时间|時間|次|回|疗程|療程|人|(?:个|個)?部位|(?:个|個)?人)|(?:什么|什麼)价值|(?:什么|什麼)價值|幾次|几次|要做幾次|要做几次|\b(?:how\s+long|how\s+much\s+time|how\s+many\s+(?:sessions?|times?|treatments?|people|areas?)|berapa\s+(?:lama|masa|kali|sesi|jam|minit|orang))\b)/iu;
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

// An explicit request to see today's price can be phrased as "想了解价钱看看"
// without "多少钱" or a final question mark. An unrelated price opinion
// cannot pass the independent explicit-price and objection checks.
const DIRECT_PRICE_LOOKUP =
  /(?:想(?:要|先)?(?:了解|知道|问|問|看看|看)|(?:可以|能|请|請)?(?:告诉|告訴|报|報|发|發)(?:我)?|麻烦|麻煩)\s*.{0,12}(?:[价價](?:格|钱|錢|位)|收[费費]|费[用]?|費用)(?=\s*(?:多少|大概|一下|看看|看|先|呢|呀|啊|吗|嗎|[?？!！。]|$))/iu;

function hasCurrentPriceAmountRequest(customerText) {
  const current = String(customerText || "").trim();
  // This shared customer-evidence gate prevents an AI priceQuery hint from
  // turning "一次多少人/部位" or benefit questions into a paid quote.
  return hasExplicitPriceRequest(current) && (
    CURRENT_PRICE_AMOUNT_REQUEST.test(current) ||
    PRICE_QUESTION_CLAUSE.test(current) || DIRECT_PRICE_LOOKUP.test(current) ||
    isFirstTrialAmountQuestion(current) ||
    LOCAL_WHATSAPP_PRICE.test(current)
  );
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
  // The customer may describe their symptoms over two replies before
  // asking "这种调理...想了解价钱看看". Reuse ONLY a recent, explicitly
  // customer-named treatment, never symptoms, ads or the model's guess.
  // Keep the existing topic-change and staff boundaries.
  if (/(?:这种|這種|这个|這個|这项|這項|this|that)\s*(?:调理|調理|疗程|療程|护理|護理|治疗|治療|treatment|care)/iu.test(current)) {
    const prior = history.filter(turn => turn?.role === "user" &&
      String(turn.content || "").trim() !== current).slice(-3);
    const concerned = /(?:腰|背|小腹|臀|屁股|骨头|骨頭|久坐|躺|床|酸|痛|紧|緊|体态|體態|姿势|姿勢|posture|back|hip|pain|aching|sitting)/iu;
    const first = prior[0];
    const firstText = String(first?.content || "").trim();
    const selected = safeServiceFromCustomer(firstText, services, serviceAliases);
    const selectedAt = Number(first?.pricingCreatedAtMs);
    if (prior.length >= 2 && selected &&
        Number.isFinite(selectedAt) && selectedAt <= Date.now() + 60_000 &&
        Date.now() - selectedAt <= 3 * 60 * 60 * 1000 &&
        findServicesInText(firstText, candidates).length === 1 &&
        !history.some(turn => turn?.role === "assistant" &&
          STAFF_PREFIX.test(String(turn.content || "").trim())) &&
        prior.slice(1).every(turn => {
          const answer = String(turn.content || "").trim();
          return answer.length > 0 && answer.length <= 150 &&
            concerned.test(answer) && !RESET.test(answer) &&
            !REFUSAL.test(answer) && !AD_BROAD_TOPIC.test(answer) &&
            !hasClinicalMediaRisk(answer) &&
            findServicesInText(answer, candidates).length === 0;
        }) &&
        !history.some(turn => turn?.role === "assistant" &&
          findServicesInText(String(turn.content || ""), candidates)
            .some(name => name !== selected.name))) {
      return { treatment: selected.name, source: "recent_customer" };
    }
  }
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
// Natural WhatsApp wording such as "通常一个疗程多少钱呢" and
// "请问整骨价钱是怎么算呢" can refer to the verified advertised service.
const AD_NATURAL_TREATMENT_FEE = /(?:通常|一般|大概|请问|請問|想问|想問|hello|halo|hi|这个|這個|广告|廣告|(?:一|1)\s*(?:个|個|次)?)?.{0,20}(?:整骨|徒手|调理|調理|护理|護理|疗程|療程|session|treatment).{0,25}(?:多少钱|多少錢|几多钱|幾多錢|价钱|價錢|价格|價格|费用|費用|怎么\s*(?:算|收费|收費)|怎麼\s*(?:算|收費))\s*(?:呢|吗|嗎|[?？])?/iu;

function isShortAdTreatmentPriceQuestion(text, { allowNaturalFee = false } = {}) {
  const current = String(text || "").normalize("NFKC").trim();
  if (!current || current.length > 80 || AD_BROAD_TOPIC.test(current) ||
      AD_UNRELATED_FEE.test(current)) return false;
  // Use the same strict monetary intent evidence as the final decision.
  // Otherwise "什么价钱呢？" can be priced from a verified customer service,
  // but not from the equally verified current ad for that service.
  // A price objection, free assessment fee or broad catalogue enquiry does
  // not become a treatment-price question merely by mentioning "价钱".
  return isStandalonePriceQuestion(current) ||
    (allowNaturalFee === true && AD_NATURAL_TREATMENT_FEE.test(current) &&
      hasExplicitPriceRequest(current) && !isPurePriceObjection(current)) ||
    AD_TREATMENT_PRICE_QUESTION.test(current) ||
    AD_ENGLISH_SESSION_PRICE.test(current) ||
    AD_MALAY_SESSION_PRICE.test(current) ||
    (hasCurrentPriceAmountRequest(current) &&
      hasExplicitPriceRequest(current) &&
      !isPurePriceObjection(current) && !REFUSAL.test(current) &&
      !RESET.test(current));
}

// Keep the established ad-only price path unchanged for other clients.
// Neutro's generic creative-headline exception is a separate opt-in below.
function legacyMetaAdPriceAnchor({
  customerText, conversationHistory, services = [], serviceAliases = [],
  metaAdContext, now = Date.now(),
} = {}) {
  if (!metaAdContext ||
      !["creative", "ad_name"].includes(metaAdContext.serviceHintSource)) return null;
  const adService = services.filter(s =>
    String(s?.name || "").trim() === metaAdContext.serviceHint);
  if (adService.length !== 1) return null;
  const name = adService[0].name;
  const attributedAtMs = Date.parse(String(metaAdContext.attributedAt || ""));
  if (!Number.isFinite(attributedAtMs) || !Number.isFinite(now) ||
      attributedAtMs > now || now - attributedAtMs > META_AD_PRICE_MAX_AGE_MS) return null;
  const current = String(customerText || "").trim();
  const candidates = serviceCandidates(services, serviceAliases);
  if (!isShortAdTreatmentPriceQuestion(current) ||
      UNRELATED.test(current) ||
      findServicesInText(current, candidates).length > 0) return null;
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  let skippedCurrent = false, previousCustomerTurns = 0;
  for (let i = history.length - 1; i >= 0; i--) {
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
    if (previousCustomerTurns > 4 || !prior || RESET.test(prior) ||
        REFUSAL.test(prior) || AD_BROAD_TOPIC.test(prior) ||
        AD_NEGATED_TOPIC.test(prior)) return null;
    const mentions = [...new Set(findServicesInText(prior, candidates))];
    if (mentions.length > 1 ||
        (mentions.length === 1 && mentions[0] !== name)) return null;
    if (mentions.length &&
        !safeServiceFromCustomer(prior, services, serviceAliases)) return null;
  }
  return { treatment: name, source: "meta_ad" };
}

function verifiedMetaAdPriceAnchor({
  customerText, conversationHistory, services = [], serviceAliases = [],
  promotions = [], metaAdContext, allowCreativeEcho = false,
  now = Date.now(),
} = {}) {
  if (allowCreativeEcho !== true) {
    return legacyMetaAdPriceAnchor({
      customerText, conversationHistory, services, serviceAliases,
      metaAdContext, now,
    });
  }
  if (!metaAdContext || !["creative", "ad_name"].includes(metaAdContext.serviceHintSource))
    return null;
  const adService = services.filter(s =>
    String(s?.name || "").trim() === metaAdContext.serviceHint);
  if (adService.length !== 1) return null;
  const name = adService[0].name;
  const attributedAtMs = Date.parse(String(metaAdContext.attributedAt || ""));
  if (!Number.isFinite(attributedAtMs) || !Number.isFinite(now) ||
      attributedAtMs > now || now - attributedAtMs > META_AD_PRICE_MAX_AGE_MS)
    return null;

  const current = String(customerText || "").trim();
  // An explicitly different body area/technique overrides an old pelvic ad,
  // even if the clinic has no separate priced package for it.
  const differentBodyService =
    /(?:筋膜|肩[颈頸膀部]|[颈頸]肩|筋膜枪|筋膜槍|\b(?:myofascial|fascia|neck|shoulder)\b)/iu;
  const pelvicMention = /(?:骨盆|盆骨|\b(?:pelvic|pelvis)\b)/iu;
  if (name === "骨盆调理" &&
      differentBodyService.test(current) && !pelvicMention.test(current)) return null;
  if (!isShortAdTreatmentPriceQuestion(current, { allowNaturalFee: true }) ||
      UNRELATED.test(current) ||
      hasClinicalMediaRisk(current) || REFUSAL.test(current) ||
      RESET.test(current) || AD_BROAD_TOPIC.test(current) ||
      AD_NEGATED_TOPIC.test(current) || SPECIFIC_ADMIN_FEE.test(current))
    return null;

  const activePriced = new Set(getActivePromotions(promotions)
    .filter(p => p?.sendOnPriceQuery === true).map(p => p.linkedService));
  if (!activePriced.has(name)) return null;
  const creative = {
    headline: metaAdContext.headline, body: metaAdContext.body,
  };
  const matches = matchingMetaAdCreativeServices(
    creative, services, serviceAliases
  );
  // An ad name only establishes a priced offer when the current creative
  // independently mentions that same priced service. Two priced offers in
  // the same ad cannot be silently reduced to a single package.
  if (!matches.includes(name) ||
      matches.some(m => m !== name && activePriced.has(m))) return null;
  const headlineMentions = new Set(matchingMetaAdCreativeServices(
    { headline: metaAdContext.headline, body: "" }, services, serviceAliases
  ));
  const echoServices = allowCreativeEcho === true ? matches.filter(m =>
    m !== name && !activePriced.has(m) && headlineMentions.has(m)
  ) : [];
  const candidates = serviceCandidates(services, serviceAliases);
  // The customer might say "整骨" because the headline of this *same* ad
  // says "徒手整骨". This is not a new choice of a competing treatment.
  // A priced treatment or any unpriced service absent from that headline
  // still overrides the ad and must not inherit its pelvic price.
  const allowedMentions = (message) => {
    const mentions = [...new Set(findServicesInText(message, candidates))];
    if (mentions.length > 1 ||
        mentions.some(m => m !== name && !echoServices.includes(m))) return false;
    return true;
  };
  if (!allowedMentions(current)) return null;

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const last = history.at(-1);
  if (last?.role !== "user" ||
      String(last.content || "").trim() !== current ||
      !Number.isFinite(last.pricingCreatedAtMs) ||
      last.pricingCreatedAtMs > now + 60_000 ||
      last.pricingCreatedAtMs < now - 24 * 60 * 60 * 1000) return null;

  let previousCustomers = 0, priorTime = now + 60_000;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn?.role !== "assistant" && turn?.role !== "user") continue;
    const at = turn.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at > priorTime ||
        at < now - 24 * 60 * 60 * 1000) return null;
    priorTime = at;
    if (turn.role === "assistant") {
      if (turn.pricingStaffAuthored === true ||
          STAFF_PREFIX.test(String(turn.content || "").trim())) return null;
      continue;
    }
    if (i === history.length - 1) continue;
    previousCustomers += 1;
    if (previousCustomers > 8) return null;
    const prior = String(turn.content || "").trim();
    if (!prior || RESET.test(prior) || REFUSAL.test(prior) ||
        AD_BROAD_TOPIC.test(prior) || AD_NEGATED_TOPIC.test(prior) ||
        hasClinicalMediaRisk(prior) || !allowedMentions(prior)) return null;
    // A fascia/neck/shoulder-specific enquiry is not a pelvic selection
    // even if a pelvic advertisement also mentions general posture.
    if (/(?:筋膜|肩[颈頸膀部]|[颈頸]肩|\b(?:myofascial|fascia|neck|shoulder)\b)/iu.test(prior) &&
        !/(?:骨盆|盆骨|\b(?:pelvis|pelvic)\b)/iu.test(prior)) return null;
  }
  return { treatment: name, source: "meta_ad", creativeEchoServices: echoServices };
}

function resolveAiPricingDecision({
  priceQuery = false, packageQuery = false, treatment = null,
  customerText, conversationHistory = [], services = [],
  serviceAliases = [], promotions = [], allowOfferEnquiries = false,
  complimentaryAssessmentExperienceEnabled = false, metaAdContext = null,
  allowVerifiedAdPricing = false, allowStaffResultPriceContext = false, now = Date.now(),
} = {}) {
  const original = String(customerText || "").trim();
  // A different treatment's refused quotation cannot veto a clearly
  // separate customer-authored price request. Do not infer from an ad or model.
  const independentRequest = resolveIndependentRefusalPriceRequest({
    customerText: original, services, serviceAliases,
  });
  if (!independentRequest && hasScopedServiceCorrection({
    customerText: original, services, serviceAliases,
  })) return null;
  const current = independentRequest?.priceText || original;
  if (independentRequest && hasClinicalMediaRisk(original)) return null;
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
      hasFuturePromotionPermissionWithoutPrice(current) ||
      (NON_MONETARY_ONLY.test(current) && !DEFINITE_MONEY.test(current) &&
        !(allowOfferEnquiries && isCurrentOfferEnquiry(current,
          { modelOfferQuery: packageQuery === true }))) ||
      isComplimentaryAssessmentFeeQuestion(
        current, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;

  // Same independently verified customer-selection rule in Enabled and
  // Shadow. Neither a model flag nor the human image alone grants authority.
  if (allowStaffResultPriceContext === true && !independentRequest) {
    const selected = resolveStaffResultPriceContext({
      customerText: current, conversationHistory, services, serviceAliases, now,
    });
    if (selected) {
      const prices = verifiedPricesForService(selected.name, promotions, selected.priceText,
        conversationHistory, { clarifiedPriceService: selected.name });
      if (prices?.length) return Object.freeze({
        type:"price", treatment:selected.name, source:"customer_staff_result_price",
        clarifiedPriceService:selected.name, prices, servicePrice:null,
      });
      return null;
    }
  }
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
  const currentOfferService = allowOfferEnquiries === true
    ? resolveCurrentOfferService({
        customerText: current, conversationHistory, services, serviceAliases,
        modelOfferQuery: packageQuery === true, now,
      }) : null;
  const monetary = Boolean((currentOfferService && !explicitOptions) || clarifiedPriceService || concernContinuation || bothContinuation) ||
    (explicitAmount && (priceQuery === true || hasExplicitPriceRequest(current))) ||
    (isStandalonePriceQuestion(current) && priceQuery === true) ||
    (isContinuedTreatmentPriceQuestion(current) && hasExplicitPriceRequest(current));
  const type = monetary ? "price" :
    allowOfferEnquiries && explicitOptions &&
    (packageQuery === true || Boolean(currentOfferService))
      ? "package_options" : null;
  if (!type) return null;
  const stripped = stripFutureFollowUpPermission(current);
  // A separate current-offer request remains valid beside future marketing
  // permission. Never interpret future consent alone as current pricing.
  if (stripped.hasFuturePermission && !hasExplicitPriceRequest(stripped.text) &&
      !currentOfferService) return null;

  const continued = type === "price" ? resolveContinuedTreatmentPriceService({
    customerText: current, conversationHistory, services, serviceAliases, promotions,
  }) : null;
  // A verified, timestamped customer-led thread can continue through a
  // complimentary introductory assessment. This must not be treated as a
  // second paid-treatment choice or rely on a model/CRM/ad-only guess.
  const established = type === "price" && hasExplicitPriceRequest(current)
    ? resolveEstablishedTreatmentPrice({
        customerText: current, session: conversationHistory,
        services, serviceAliases, now,
      }) : null;
  const anchor = independentRequest
    ? { treatment: independentRequest.treatment, source: "current_customer" }
    : currentOfferService
    ? { treatment: currentOfferService.name, source: "customer_current_offer" }
    : continued
    ? { treatment: continued.name, source: "continued_customer" }
    : concernContinuation || bothContinuation
      ? { treatment: (concernContinuation || bothContinuation).name,
          source: bothContinuation ? "customer_concern_both" : "customer_concern_continuation" }
    : established
      ? { treatment: established.name, source: "customer_established_treatment" }
    : (() => {
        const customer = verifiedServiceAnchor({
          customerText: current, conversationHistory, services, serviceAliases,
          modelTreatment: treatment,
        });
        const ad = verifiedMetaAdPriceAnchor({
          customerText: current, conversationHistory, services, serviceAliases,
          promotions, metaAdContext,
          allowCreativeEcho: allowVerifiedAdPricing, now,
        });
        // A customer naming a different treatment always wins. The only
        // exception is a generic service word copied from this ad's own
        // headline, e.g. 徒手整骨 in a verified pelvic advertisement.
        return customer && (!ad ||
          !ad.creativeEchoServices?.includes(customer.treatment))
          ? customer : (ad || customer);
      })();
  if (!anchor || (clarifiedPriceService &&
      clarifiedPriceService !== anchor.treatment)) return null;

  // A single decision supplies the same package choices and amounts to both
  // the text formatter and the optional media selector. Missing/conflicting
  // prices are recorded as null and must never authorize promo media.
  const prices = verifiedPricesForService(
    anchor.treatment, promotions,
    currentOfferService ? currentOfferRequestText(current,
      { modelOfferQuery: packageQuery === true }) : current,
    conversationHistory, { clarifiedPriceService, allowTextOnlyOffers: true }
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
    ...(independentRequest ? {
      scopedPriceText: independentRequest.priceText,
      scopedRefusedTreatment: independentRequest.refusedTreatment,
    } : {}),
  });
}

// Gemini classifies the current intent. Verify factual service/package evidence,
// rather than requiring another affirmative price-keyword match.
// Existing price-relative phrases are negative validation evidence only;
// they cannot independently authorize a quote or override a model selection.
function relativePackageReference(current) {
  const cheaper=/(?:较便宜|較便宜|比较便宜|比較便宜|最便宜|更便宜|\b(?:cheaper|cheapest|lowest priced|lebih murah|paling murah)\b)/iu.test(current);
  const dearer=/(?:较贵|較貴|比较贵|比較貴|最贵|最貴|更贵|更貴|\b(?:more expensive|most expensive|highest priced|lebih mahal|paling mahal)\b)/iu.test(current);
  return {cheaper,dearer};
}

// Negative evidence only: a complete, ordinary introduction to a configured
// service is not an amount request. Match the whole message around the
// configured name/alias, not individual positive pricing keywords. Any
// additional question remains for the model and existing validators.
function isPlainNamedTreatmentInterest(current, candidate) {
  if (!candidate || hasExplicitPriceRequest(current) ||
      hasExplicitPackageOptionsRequest(current)) return false;
  const key=value=>String(value||"").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu,"");
  const text=key(current);
  for (const term of candidate.terms) {
    const name=key(term.value);
    if (!name) continue;
    const at=text.indexOf(name);
    if(at<0) continue;
    const before=text.slice(0,at), after=text.slice(at+name.length);
    if (/^(?:(?:你好|您好|hi|hello))?(?:我)?(?:也|还|還|现在|現在|这次|這次)?(?:想|要|希望)(?:了解|知道|咨询|諮詢|问问|問問|看看|做|试试|試試)$/u.test(before) &&
        /^(?:疗程|療程|护理|護理|治疗|治療|的资料|的資料|的介绍|的介紹|一下)?$/u.test(after)) return true;
    if (/^(?:(?:hi|hello))?(?:im|iam|idlike|iwouldlike|iwant)(?:also)?(?:interestedin|toknowmoreabout|tolearnmoreabout|toknowabout|tolearnabout|tofindoutabout|totry|toaskabout)(?:the|your)?$/u.test(before) &&
        /^(?:facial)?(?:treatment|care|service)?(?:please)?$/u.test(after)) return true;
    if (/^(?:(?:hi|hello))?(?:saya)?(?:juga)?(?:berminat(?:dengan|tentang|untuk)?|nak(?:tahu(?:tentang)?|cuba)|mahu(?:tahu(?:tentang)?|cuba))(?:rawatan)?$/u.test(before) &&
        /^(?:rawatan|care)?$/u.test(after)) return true;
  }
  return false;
}

// A delivered recommendation can establish a service only after the customer
// participates in that particular treatment discussion. This is not a service
// inference from symptoms, an ad, a CRM field or an isolated assistant name.
function engagedRecommendationAnchor({turns, treatment, candidates, current, now}) {
  if (!hasExplicitPriceRequest(current) && !isStandalonePriceQuestion(current)) return -1;
  const end=turns.length-1;
  for (let i=end-2;i>=Math.max(1,end-8);i--) {
    const t=turns[i], copy=pricingMessageText(t).trim();
    if (t?.role!=="assistant" || t.pricingDeliveredBotMessage!==true ||
        isVerifiedStaffTurn(t) || t.verifiedOutboundImageUrl ||
        !findServicesInText(copy,candidates).includes(treatment) ||
        assistantIntroducesCompetingPaidService(t,treatment,candidates) ||
        !/[?？]\s*$/u.test(copy) || !isRecentPricingThread(turns,i,now)) continue;
    const before=turns[i-1], answer=turns[i+1];
    const meaningful=t=>t?.role==="user" && typeof t.content==="string" &&
      t.content.trim().length>0 && !isGreetingOrLanguageOnly(t.content) &&
      !RESET.test(t.content) && !REFUSAL.test(t.content) &&
      !AD_NEGATED_TOPIC.test(t.content) && !AD_BROAD_TOPIC.test(t.content) &&
      !hasClinicalMediaRisk(t.content) && !UNRELATED.test(t.content) &&
      !hasExplicitPriceRequest(t.content) &&
      !/^\s*(?:thanks?|thank you|terima kasih|谢谢|謝謝|ok(?:ay)?|好的|明白了|了解了)[\s.!！。]*$/iu.test(t.content);
    if (!meaningful(before) || !meaningful(answer) || /[?？]/u.test(answer.content)) continue;
    const safe=turns.slice(i+1,end).every(t=>{
      const value=pricingMessageText(t);
      if(t?.role==="user") return meaningful(t) &&
        findServicesInText(value,candidates).every(name=>name===treatment);
      if(t?.role!=="assistant" || isVerifiedStaffTurn(t) ||
          t.pricingDeliveredBotMessage!==true || t.verifiedOutboundImageUrl ||
          /\b(?:RM|MYR)\s*\d/iu.test(value)) return false;
      // A clearly complimentary introductory assessment is not a second
      // paid recommendation, even if this particular turn omits the service.
      const names=findServicesInText(value,candidates);
      if(names.length && names.every(name=>name==="1对1体态评估") &&
          /(?:免费|免費|complimentary|free|percuma)/iu.test(value)) return true;
      return !assistantIntroducesCompetingPaidService(t,treatment,candidates);
    });
    if(safe) return i;
  }
  return -1;
}

function resolveModelLedPricingDecision({
  modelIntent, customerText, conversationHistory = [], services = [],
  serviceAliases = [], promotions = [], allowOfferEnquiries = false,
  complimentaryAssessmentExperienceEnabled = false, now = Date.now(),
} = {}) {
  const original = String(customerText || "").trim();
  const intent = modelIntent;
  if (!intent || intent.structured !== true || intent.outcome !== "normal" ||
      intent.pricingStage === "subsequent_session" ||
      (intent.priceQuery !== true &&
        !(allowOfferEnquiries && intent.packageQuery === true)) ||
      !original || original.length > 600 || !Number.isFinite(now) ||
      !services.some(s => s?.name === intent.treatment)) return null;
  const independent = resolveIndependentRefusalPriceRequest({
    customerText:original,services,serviceAliases,
  });
  if (independent && independent.treatment!==intent.treatment) return null;
  if (!independent && (hasCustomerRefusedPriceQuote(original) ||
      hasScopedServiceCorrection({customerText:original,services,serviceAliases}))) return null;
  const current=independent?.priceText || original;
  // Negative safety/permission gates remain independent of model output.
  // The existing refusal resolver permits a distinctly requested NEW service.
  if (isGreetingOrLanguageOnly(current) || hasClinicalMediaRisk(original) ||
      SPECIFIC_ADMIN_FEE.test(original) || REFUSAL.test(current) ||
      AD_NEGATED_TOPIC.test(current) || AD_BROAD_TOPIC.test(current) ||
      /\b(?:stop|unsubscribe)\b|退订|退訂/iu.test(original) ||
      isPurePriceObjection(current) || hasFuturePromotionPermissionWithoutPrice(current) ||
      isContextualAdServiceEnquiry(current) ||
      /^(?:谢谢(?:你|您)?|多谢|thanks?|thank you|terima kasih|tq|ok(?:ay)?|好的|好啊|明白了|了解了)[\s。.!！😊🙏]*$/iu.test(current) ||
      /^(?:一次(?:就)?(?:有)?效(?:果)?(?:吗|嗎|么|呢)?|(?:how effective|does it work|will it work|berkesan(?: ke| tak)?)\b)[\s?？。.!！]*$/iu.test(current) ||
      (UNRELATED.test(current) && !hasExplicitPriceRequest(current)) ||
      (NON_MONETARY_ONLY.test(current) && !DEFINITE_MONEY.test(current)) ||
      isComplimentaryAssessmentFeeQuestion(current,
        complimentaryAssessmentExperienceEnabled, conversationHistory)) return null;

  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  const last = turns.at(-1);
  if (last?.role !== "user" || typeof last.content !== "string" ||
      last.content.trim() !== original ||
      !isRecentPricingThread(turns, turns.length - 1, now)) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  const direct = safeServiceFromCustomer(current, services, serviceAliases);
  const names = [...new Set(findServicesInText(current, candidates))];
  const bareKey=value=>String(value||"").normalize("NFKC").replace(/[\s?？.!！。]+/gu,"").toLowerCase();
  // A bare service name is interest, not a price request, unless a preceding
  // verified pricing clarification actually asked the customer to select it.
  const namedCandidate=direct && candidates.find(c=>c.name===direct.name);
  if (namedCandidate) {
    const bare=namedCandidate.terms.some(t=>bareKey(t.value)===bareKey(current));
    const introduction=isPlainNamedTreatmentInterest(current,namedCandidate);
    if (bare || introduction) {
      const clarified=resolveClarifiedPriceService({customerText:current,conversationHistory:turns,services,serviceAliases});
      // A plain interest statement can inherit only an unanswered price
      // clarification, not a price menu that already answered the question.
      if (!clarified || (introduction && hasTreatmentPriceContent(pricingMessageText(turns.at(-2))))) return null;
    }
  }
  if (names.length > 1 || (names.length && direct?.name !== intent.treatment) ||
      (direct && direct.name !== intent.treatment) ||
      (RESET.test(current) && !direct)) return null;
  let anchorIndex=turns.length-1;
  if (!direct) {
    // Search the bounded recent conversation for the latest genuine
    // customer-named service, allowing ordinary intermediate questions.
    // An intervening contradictory selection or an unknown topic reset
    // invalidates the older anchor. Never infer treatment solely from an ad,
    // CRM label, isolated assistant recommendation or model guess.
    anchorIndex=-1;
    for (let i=turns.length-2;i>=0;i--) {
      const turn=turns[i], at=turn?.pricingCreatedAtMs;
      if (!Number.isFinite(at) || at>now+60_000) return null;
      if (at<now-24*3600000) break;
      if (turn.role!=="user") continue;
      if (typeof turn.content!=="string") return null;
      const prior=pricingMessageText(turn).trim();
      if (!prior || RESET.test(prior) || REFUSAL.test(prior) ||
          AD_NEGATED_TOPIC.test(prior) || AD_BROAD_TOPIC.test(prior) ||
          hasClinicalMediaRisk(prior)) return null;
      const mentioned=[...new Set(findServicesInText(prior,candidates))];
      if (!mentioned.length) continue;
      if (mentioned.length!==1 || mentioned[0]!==intent.treatment ||
          safeServiceFromCustomer(prior,services,serviceAliases)?.name!==intent.treatment) return null;
      anchorIndex=i;
      break;
    }
    const recommendationOnly=anchorIndex<0;
    if (recommendationOnly) anchorIndex=engagedRecommendationAnchor({turns,treatment:intent.treatment,candidates,current,now});
    if (anchorIndex<0 || !isRecentPricingThread(turns,anchorIndex,now)) return null;
    const responses=turns.slice(anchorIndex+1,-1).filter(t=>t.role==="assistant");
    // Assistant explanations and generic safety disclaimers are not customer
    // symptoms. An older bot introduction may name several applications;
    // use the most recent explicitly named service context, while retaining
    // independent customer, staff, and current clinical/safety vetoes.
    const latestNamedResponse=responses.findLast(t=>
      findServicesInText(pricingMessageText(t),candidates).length>0);
    if (!recommendationOnly && (!latestNamedResponse ||
        !findServicesInText(pricingMessageText(latestNamedResponse),candidates)
          .includes(intent.treatment) ||
        assistantIntroducesCompetingPaidService(latestNamedResponse,intent.treatment,candidates))) return null;
  }
  // Known readable staff assistance is conversation evidence, not a
  // takeover. Unknown/deleted echoes and unverified/conflicting staff prices
  // cannot supply a new price authorization. Live ownership is checked by
  // the existing send boundary; clinical context remains a hard veto.
  for (let i=turns.length-2;i>=0;i--) {
    const t=turns[i], at=t?.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at>now+60_000) return null;
    if (at<now-24*3600000) break;
    const content=pricingMessageText(t);
    if (hasClinicalMediaRisk(content) &&
        (t.role==="user" || (i>=anchorIndex && isVerifiedStaffTurn(t)))) return null;
    if (isVerifiedStaffTurn(t) && i>=anchorIndex &&
        (!(t.pricingDeliveredStaffImage===true || t.pricingVerifiedStaffText===true) ||
         t.pricingBusinessAppPlaceholder===true || /\[unsupported|message deleted/iu.test(content) ||
         /\b(?:RM|MYR)\s*\d|[价價][钱錢格位]|\b(?:price|cost|harga)\b/iu.test(content) ||
         assistantIntroducesCompetingPaidService(t,intent.treatment,candidates))) return null;
  }

  // Verify all configured options first, then honor Gemini's single package
  // only when supported by a customer mention or a verified preceding menu.
  const active=getActivePromotions(promotions,new Date(now))
    .filter(p=>p.linkedService===intent.treatment && p.sendOnPriceQuery===true);
  if (active.length!==1) return null;
  const options=promotionPackages(active[0]);
  const all=verifiedPricesForService(intent.treatment,promotions,"",[],
    {allowTextOnlyOffers:true});
  if (!all?.length || all.length!==options.length) return null;
  const mentioned=findMentionedPromotionPackages(options,current);
  let prices=all;
  if (intent.promotionOption != null) {
    const selected=all.find(p=>p.name===intent.promotionOption);
    if (!selected || mentioned.length>1 ||
        (mentioned.length===1 && mentioned[0].name!==selected.name)) return null;
    // For an indirect reference, only accept a choice grounded in the same
    // customer's explicit package selection or the latest bot menu showing
    // verified current amounts. A bounded run of delivered, exact matching
    // package artwork can follow the menu without erasing its context.
    let menuIndex=turns.length-2;
    const matchingImages=new Set(options.map(p=>p.imageUrl).filter(Boolean));
    let skipped=0;
    while(menuIndex>anchorIndex && skipped<options.length){
      const t=turns[menuIndex];
      if(t?.role!=="assistant" || isVerifiedStaffTurn(t) ||
         t.pricingDeliveredBotMessage!==true ||
         !matchingImages.has(t.verifiedOutboundImageUrl)) break;
      menuIndex--;skipped++;
    }
    const previous=turns[menuIndex];
    const previousText=pricingMessageText(previous);
    const priorCustomer=turns.slice(anchorIndex,-1).findLast(t=>t.role==="user");
    const priorChoice=findMentionedPromotionPackages(options,pricingMessageText(priorCustomer));
    const listed=findMentionedPromotionPackages(options,previousText);
    const menuSupports=previous?.role==="assistant" && !isVerifiedStaffTurn(previous) &&
      (!skipped || (previous.pricingDeliveredBotMessage===true &&
        !previous.verifiedOutboundImageUrl)) &&
      !assistantIntroducesCompetingPaidService(previous,intent.treatment,candidates) &&
      findServicesInText(previousText,candidates).includes(intent.treatment) &&
      listed.length>1 && all.every(p=>{
        // Non-monetary voucher explanations may repeat the package label.
        // Only price-bearing rows supply amounts, and conflicting amounts
        // on any additional labelled monetary row still invalidate the menu.
        const lines=previousText.split(/\n+/u).filter(line=>
          /\b(?:RM|MYR)\s*[0-9]/iu.test(line) &&
          findMentionedPromotionPackages(options,line).some(o=>o.name===p.name));
        return lines.length===1 && lines.every(line=>{
          const named=findMentionedPromotionPackages(options,line);
          const amounts=[...line.matchAll(/\b(?:RM|MYR)\s*([1-9]\d{0,5})(?!\d)/giu)];
          return named.length===1 && amounts.length===1 &&
            "RM"+amounts[0][1]===p.price;
        });
      });
    if (!mentioned.length && !(priorChoice.length===1 && priorChoice[0].name===selected.name) &&
        !menuSupports && options.length!==1) return null;
    // Price-relative references must agree with the actual uniquely cheapest
    // or highest-priced option. Other semantic references rely on a grounded
    // menu and the model; do not treat ambiguous price ties as a selection.
    if (!mentioned.length && options.length>1) {
      const {cheaper,dearer}=relativePackageReference(current);
      if (cheaper || dearer) {
        if (!menuSupports || (cheaper && dearer)) return null;
        const amount=p=>Number(p.price.slice(2));
        const target=(cheaper?Math.min:Math.max)(...all.map(amount));
        const matching=all.filter(p=>amount(p)===target);
        if (matching.length!==1 || matching[0].name!==selected.name) return null;
      }
    }
    prices=[selected];
  } else if (mentioned.length===0 && options.length>1 &&
      Object.values(relativePackageReference(current)).some(Boolean)) {
    // A missing model selection is not authorization to quote every package.
    return null;
  } else if (mentioned.length===1) {
    // A specific customer choice cannot be silently widened to all packages.
    return null;
  } else if (mentioned.length>1) {
    // Explicit comparisons retain the existing text-only graphic policy.
    prices=all.filter(p=>mentioned.some(o=>o.name===p.name));
  }
  return Object.freeze({
    type:intent.priceQuery===true ? "price" : "package_options",
    treatment:intent.treatment,source:independent?"current_customer":"model_led_customer_context",
    clarifiedPriceService:intent.treatment,prices,servicePrice:null,
    ...(independent?{scopedPriceText:independent.priceText,scopedRefusedTreatment:independent.refusedTreatment}:{}),
  });
}

// A recent, conflicting staff quote is a commercial veto, not a reason
// to fall back to an older keyword-based decision. Only inspect staff
// prices relevant to the currently established treatment.
function hasConflictingStaffPrice({treatment,conversationHistory=[],services=[],
  serviceAliases=[],promotions=[],now=Date.now()}={}){
  if (!treatment || !Array.isArray(conversationHistory)) return false;
  const candidates=serviceCandidates(services,serviceAliases);
  const verified=verifiedPricesForService(treatment,promotions,"",[],{allowTextOnlyOffers:true});
  for(let i=conversationHistory.length-2;i>=0;i--){
    const turn=conversationHistory[i],at=turn?.pricingCreatedAtMs;
    if(!Number.isFinite(at)||at<now-24*3600000||at>now+60_000) break;
    const content=pricingMessageText(turn);
    const names=findServicesInText(content,candidates);
    if(turn.role==="user" && names.length && !names.includes(treatment)) break;
    if(!isVerifiedStaffTurn(turn) || (names.length && !names.includes(treatment))) continue;
    if (!/\b(?:RM|MYR)\s*\d/iu.test(content.normalize("NFKC"))) continue;
    const active=getActivePromotions(promotions,new Date(now))
      .filter(p=>p.linkedService===treatment && p.sendOnPriceQuery===true);
    if (!verified?.length || active.length!==1 || names.length>1) return true;
    const options=promotionPackages(active[0]);
    const matches=(copy,option)=>{
      const price=verified.find(p=>p.name===option.name);
      return Boolean(price && staffQuoteMatchesConfiguredPrice(copy,option.pricing,price));
    };
    if (options.length===1) {
      if (!matches(content,options[0])) return true;
      continue;
    }
    // Associate labelled package blocks, including continuation lines with
    // original prices and voucher terms, before checking payable amounts.
    const groups=[];
    let group=null;
    for (const line of content.split(/\n+/u)) {
      const named=findMentionedPromotionPackages(options,line);
      if(named.length>1) return true;
      if(named.length===1) {
        if(group?.option.name!==named[0].name){
          group={option:named[0],lines:[]};groups.push(group);
        }
      }
      if(group)group.lines.push(line);
      else if(/\b(?:RM|MYR)\s*\d/iu.test(line))return true;
    }
    if(!groups.length || groups.some(g=>!matches(g.lines.join("\n"),g.option)))return true;
  }
  return false;
}

// A failed semantic package selection must not widen into an unrelated
// legacy menu. Preserve independently established special cases and direct
// customer package selections that exactly match a verified legacy quote.
function shouldBlockRejectedModelPricing({mode,modelIntent,semanticCandidate,
  semanticApproval,legacyApproval,hasSpecialDecision=false,customerText,
  promotions=[]}={}){
  // Returning-treatment recovery proves the treatment, not permission to
  // widen a verified or requested package. Other protected paths stay intact.
  const returning=legacyApproval?.decision?.source==="customer_returning_treatment_price";
  const requestedPackageScope=modelIntent?.promotionOption!=null ||
    Object.values(relativePackageReference(String(customerText||""))).some(Boolean);
  if(mode!=="enabled" || (hasSpecialDecision && !(returning && requestedPackageScope)) || semanticApproval?.decision ||
    !modelIntent?.structured || modelIntent.outcome!=="normal" ||
    !(modelIntent.priceQuery===true || modelIntent.packageQuery===true))return false;
  const legacy=legacyApproval?.decision;
  if(semanticCandidate)return true; // final commercial rejection
  if(modelIntent.promotionOption!=null){
    const active=getActivePromotions(promotions)
      .filter(p=>p.linkedService===modelIntent.treatment && p.sendOnPriceQuery===true);
    const named=active.length===1
      ? findMentionedPromotionPackages(promotionPackages(active[0]),customerText):[];
    return !(named.length===1 && named[0].name===modelIntent.promotionOption &&
      legacy?.treatment===modelIntent.treatment && legacy.prices?.length===1 &&
      legacy.prices[0].name===named[0].name);
  }
  if (Object.values(relativePackageReference(String(customerText||""))).some(Boolean)) {
    const active=getActivePromotions(promotions)
      .filter(p=>p.linkedService===modelIntent.treatment && p.sendOnPriceQuery===true);
    if(active.length===1 && promotionPackages(active[0]).length>1) return true;
  }
  return Boolean(legacy && modelIntent.treatment && legacy.treatment!==modelIntent.treatment);
}

// Enabled prioritizes a validated Gemini decision. Final legacy rejection
// and distinct special-case authorities remain protected. A broader verified
// returning-treatment quote can yield only to an exact approved subset.
function shouldApplyModelLedPricing({mode,legacyCandidate,
  legacyApproval,semanticApproval,hasSpecialDecision=false}={}){
  const legacy=legacyApproval?.decision, semantic=semanticApproval?.decision;
  if(mode!=="enabled" || !semantic || (legacyCandidate && !legacy)) return false;
  if(!hasSpecialDecision) return true;
  // Only this broad returning-customer fallback may yield to a narrower
  // independently approved package scope. Do not change treatment, amounts,
  // or override other protected special decisions or a final rejection.
  return legacy?.source==="customer_returning_treatment_price" &&
    legacy.type==="price" && semantic.type==="price" &&
    legacy.treatment===semantic.treatment &&
    Array.isArray(legacy.prices) && Array.isArray(semantic.prices) &&
    semantic.prices.length>0 && semantic.prices.length<legacy.prices.length &&
    semantic.prices.every(p=>legacy.prices.some(old=>old.name===p.name && old.price===p.price));
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
      pricingDecision?.source === "customer_current_offer" ||
      pricingDecision?.type === "package_options");
}

// Compatibility alias for existing imports in downstream tests.
module.exports = { shouldBlockRejectedModelPricing, hasConflictingStaffPrice, shouldApplyModelLedPricing, resolveModelLedPricingDecision, resolveAiPricingDecision, verifiedServiceAnchor, verifiedMetaAdPriceAnchor, isPurePriceObjection, hasCurrentPriceAmountRequest, hasCustomerRequestedPriceReply };
