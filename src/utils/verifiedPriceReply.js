"use strict";

const { getActivePromotions, promotionPackages, findAmbiguousPromotionPackageTerm, findMentionedPromotionPackages } = require("./activePromotion");
const { hasExplicitPriceRequest, isStandalonePriceQuestion, hasExplicitPackageOptionsRequest, hasCustomerServiceEnquiry, stripFutureFollowUpPermission } = require("./customerEnquiryEvidence");
const { isContextualPriceReference, resolveContinuedTreatmentPriceService, resolveRecentFirstTreatmentPriceService } = require("./priceFollowUpContext");
const { hasTreatmentPriceContent, hasCommercialReplyContent, safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");
const clinicConfig = require("../config/clinicConfig");
const {normalizeMoneyText,scanMyrAmounts}=require("./myrAmountClaims");
const {serviceCandidates,findServicesInText}=require("./conversationPromptContext");
const { isComplimentaryAssessmentFeeQuestion, complimentaryAssessmentFeeReply } = require("./complimentaryAssessmentExperience");

// A voucher, discount, original price or bare amount is never a sale price.
// "After voucher" has priority over a separate pre-voucher promo price.
const FINAL_SALE = /(?:优惠后(?:仅需|只需)?|優惠後(?:僅需|只需)?|after\s+(?:the\s+)?voucher(?:,?\s*only)?|selepas\s+baucar(?:,?\s*hanya)?)\s*[:：]?\s*(?:RM|MYR)\s*([1-9]\d{1,4})(?!\d)/giu;
const DIRECT_SALE = /(?:现在只需|現在只需|现在仅需|現在僅需|只需要|只需|仅需|僅需|优惠价|優惠價|现价|現價|特价|特價|促销价|促銷價|组合体验价(?:只需)?|組合體驗價(?:只需)?|组合限时优惠|組合限時優惠|limited[\s-]*time\s+combo\s+offer|promosi\s+kombo[^\n:：]{0,60}|first[\s-]*trial(?:\s+price)?|trial\s+price|(?:current\s+)?(?:promo|promotional|special|offer|sale)\s+price|now\s+only|harga\s+promosi|harga\s+tawaran|sekarang\s+hanya)\s*[:：]?\s*(?:RM|MYR)\s*([1-9]\d{1,4})(?!\d)/giu;
const MONEY = /\b(?:RM|MYR)\s*\d{2,5}\b/giu;
const BARE_SALE = /^[ \t]*(?:💎[ \t]*)?(?:RM|MYR)[ \t]*([1-9]\d{1,4})[ \t]*(?:[.!。！])?$/gmi;
const ORIGINAL = /(?:原价(?:优惠)?|原價(?:優惠)?|original\s+price|harga\s+asal|normal\s+price)\s*[:：]?\s*(?:RM|MYR)\s*(?:\d{1,3},)?\d{2,5}\b/giu;
const VOUCHER_AFTER = /(?:RM|MYR)\s*\d{2,5}\b\s*(?:voucher|coupon|off|discount|baucar|优惠券|優惠券|折扣券|抵用券|折扣)/giu;
const VOUCHER_BEFORE = /(?:voucher|coupon|baucar|优惠券|優惠券|折扣券|抵用券|折扣)\s*(?:worth\s*)?(?:RM|MYR)\s*\d{2,5}\b/giu;

function priceEvidence(copy) {
  const normalized = String(copy || "").normalize("NFKC").replace(/[\uFE0F\u20E3]/gu, "");
  const originalPrices = [...normalized.matchAll(ORIGINAL)]
    .map((match) => Number(match[0].match(/(?:RM|MYR)\s*([\d,]+)/iu)?.[1]?.replace(/,/g, "")))
    .filter((amount) => Number.isSafeInteger(amount) && amount > 0);
  const finalMatches = [...normalized.matchAll(FINAL_SALE)];
  const directMatches = [...normalized.matchAll(DIRECT_SALE)];
  const bareMatches = /(?:限时优惠|限時優惠|limited[\s-]*time\s+offer|promosi\s+masa\s+terhad)/iu.test(normalized)
    ? [...normalized.matchAll(BARE_SALE)] : [];
  const preferred = finalMatches.length ? finalMatches : (directMatches.length ? directMatches : bareMatches);
  const distinct = [...new Set(preferred.map((m) => m[1]))];
  if (distinct.length !== 1) {
    const unlabeled = normalized.replace(ORIGINAL, " ").replace(VOUCHER_AFTER, " ").replace(VOUCHER_BEFORE, " ");
    return { price: null, originalPrices,
      ambiguous: preferred.length > 0 || Boolean(unlabeled.match(MONEY)) };
  }
  let remaining = normalized;
  const claims = [...finalMatches, ...directMatches, ...bareMatches].sort((a, b) => b.index - a.index);
  // Overlapping phrases may produce nested matches. Blank them from right
  // to left without shifting source offsets.
  const covered = new Set();
  for (const match of claims) {
    const start = match.index, finish = start + match[0].length;
    for (let i = start; i < finish; i++) covered.add(i);
  }
  remaining = normalized.split("").map((char, i) => covered.has(i) ? " " : char).join("");
  remaining = remaining.replace(ORIGINAL, " ").replace(VOUCHER_AFTER, " ").replace(VOUCHER_BEFORE, " ");
  if (remaining.match(MONEY)) return { price: null, originalPrices, ambiguous: true };
  return { price: "RM" + distinct[0], originalPrices, ambiguous: false };
}

function configuredOfferPrice(copy) {
  return priceEvidence(copy).price;
}

// Existing Neutro copy includes emoji digits such as "RM 4️⃣8️⃣8️⃣" in
// translations. When a structured MYR amount is configured, a price without a
// "now only" label can still be checked: every unlabelled monetary amount must
// match the configured offer, and any stated original price must match normal.
// Without structured pricing the older strict evidence rule remains in place.
function ambiguousCopyMatchesStructuredPrice(copy, structured) {
  if (structured?.currency !== "MYR" ||
      !Number.isSafeInteger(structured.offer) || structured.offer <= 0) return false;
  const source = String(copy || "").normalize("NFKC")
    .replace(/[\uFE0F\u20E3]/gu, "");
  const originals = [...source.matchAll(ORIGINAL)].map((match) =>
    Number(match[0].match(/(?:RM|MYR)\s*([\d,]+)/iu)?.[1]?.replace(/,/g, ""))
  );
  if (originals.length && (!Number.isSafeInteger(structured.normal) ||
      originals.some((amount) => amount !== structured.normal))) return false;
  const withoutLabels = source.replace(ORIGINAL, " ")
    .replace(VOUCHER_AFTER, " ").replace(VOUCHER_BEFORE, " ");
  const amounts = [...withoutLabels.matchAll(MONEY)].map((match) =>
    Number(match[0].match(/\d+/u)?.[0])
  );
  return amounts.length > 0 && amounts.every((amount) => amount === structured.offer);
}

// Check a staff quote against the configured option without confusing labelled
// normal prices and vouchers with its payable price. Ambiguity fails closed.
function staffQuoteMatchesConfiguredPrice(copy,structured,verified){
  const source=String(copy||"").normalize("NFKC").replace(/[\uFE0F\u20E3]/gu,"");
  if(!verified?.price)return false;
  const evidence=priceEvidence(source);
  if(evidence.originalPrices.some(n=>!Number.isSafeInteger(structured?.normal) ||
      n!==structured.normal))return false;
  const vouchers=[...source.matchAll(VOUCHER_AFTER),...source.matchAll(VOUCHER_BEFORE)];
  if(vouchers.some(m=>{
    const n=Number(m[0].match(/\d+/u)?.[0]);
    return !verified.afterVoucher || !Number.isSafeInteger(structured?.normal) ||
      !Number.isSafeInteger(structured?.offer) || n!==structured.normal-structured.offer;
  }))return false;
  const payable=source.replace(ORIGINAL," ").replace(VOUCHER_AFTER," ").replace(VOUCHER_BEFORE," ");
  const amounts=[...payable.matchAll(/\b(?:RM|MYR)\s*([1-9]\d{0,5})(?![\d.,])/giu)];
  if(!amounts.length)return false;
  if(evidence.price && evidence.price!==verified.price)return false;
  if(evidence.ambiguous && structured && !ambiguousCopyMatchesStructuredPrice(source,structured))return false;
  return amounts.every(m=>"RM"+m[1]===verified.price);
}

// Resolve package choices once for both the customer-facing text and any
// optional promotional images. Multiple explicitly named packages are valid.
// Carry a package from history only for a standalone price follow-up; a new
// treatment-price question must not inherit an older package preference.
function requestedPricePackages(packages, customerText, conversationHistory = [], {
  clarifiedPriceService = null, treatment = null,
} = {}) {
  const candidates = Array.isArray(packages) ? packages : [];
  const direct = findMentionedPromotionPackages(candidates, customerText);
  if (direct.length) return direct;

  // "Package B price?" -> "Which treatment?" -> "骨盆" remains one
  // explicit price request. Only a separately verified immediate clarification
  // can carry the package choice over to a service-only customer answer.
  if (clarifiedPriceService && clarifiedPriceService === treatment) {
    const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
      .filter((entry) => entry?.role === "user" || entry?.role === "assistant");
    const earlier = turns.at(-3);
    if (earlier?.role === "user" &&
        hasExplicitPriceRequest(earlier.content) &&
        turns.at(-2)?.role === "assistant" &&
        turns.at(-1)?.role === "user" &&
        String(turns.at(-1)?.content || "").trim() === String(customerText || "").trim()) {
      const selected = findMentionedPromotionPackages(candidates, earlier.content);
      if (selected.length) return selected;
    }
  }

  if (!isStandalonePriceQuestion(customerText) &&
      !isContextualPriceReference(customerText)) return candidates;

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const current = String(customerText || "").trim();
  let skippedCurrent = false;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== "user") continue;
    if (!skippedCurrent && typeof entry.content === "string" &&
        entry.content.trim() === current) {
      skippedCurrent = true;
      continue;
    }
    // An intervening photo or unsupported message never grants a stale
    // package selection. Only the immediately previous customer text counts.
    if (typeof entry.content !== "string") return candidates;
    const previous = findMentionedPromotionPackages(candidates, entry.content);
    return previous.length ? previous : candidates;
  }
  return candidates;
}

function verifiedPricesForService(treatment, promotions, customerText = "", conversationHistory = [], {
  clarifiedPriceService = null, allowTextOnlyOffers = false,
} = {}) {
  const related = getActivePromotions(promotions).filter((promotion) =>
    String(promotion.linkedService || "").trim() === treatment
  );
  const automatic = related.filter((promotion) => promotion.sendOnPriceQuery === true);
  // One automatic campaign owns the actual image. An overlapping text-only
  // campaign must not hide an otherwise unambiguous graphic if its price is
  // the same, but contradictory current pricing must still fail closed.
  const matching = automatic.length
    ? automatic
    : allowTextOnlyOffers ? related : [];
  if (matching.length !== 1 || findAmbiguousPromotionPackageTerm(matching[0])) return null;
  const options = promotionPackages(matching[0]);
  if (!options.length || options.length > 4) return null;
  const selected = requestedPricePackages(options, customerText, conversationHistory, {
    clarifiedPriceService, treatment,
  });
  const result = [];
  for (const option of selected) {
    if (!String(option.name || "").trim()) return null;
    const translations = Object.values(option.mediaTranslations || {})
      .map((item) => typeof item === "string" ? item : item?.caption);
    const followUpTranslations = Object.values(option.followUpTranslations || {})
      .map((item) => typeof item === "string" ? item : item?.message);
    const sources = [option.caption, option.followUpMessage, ...translations, ...followUpTranslations]
      .filter((source) => String(source || "").trim());
    const evidence = sources.map(priceEvidence);
    const structured = option.pricing;
    const configured = structured?.currency === "MYR" &&
      Number.isSafeInteger(structured.offer) && structured.offer > 0 &&
      (structured.normal == null || structured.normal >= structured.offer)
      ? "RM" + structured.offer : null;
    // Structured prices are authoritative only if no readable sales amount in
    // any translated caption conflicts. Unverified legacy copy stays closed.
    if (evidence.some((entry, index) => entry.ambiguous &&
      !ambiguousCopyMatchesStructuredPrice(sources[index], structured))) return null;
    const unique = [...new Set(evidence.map((entry) => entry.price).filter(Boolean))];
    const originals = [...new Set(evidence.flatMap(entry => entry.originalPrices))];
    if (configured && unique.some((price) => price !== configured)) return null;
    if (!configured && unique.length !== 1) return null;
    // Do not allow translated caption RM999 to contradict a configured
    // RM888 normal price while the RM488 trial price happens to match.
    if (originals.length > 1 || (structured?.normal != null &&
      originals.some(normal => normal !== structured.normal))) return null;
    const localizedCaptions = [option.caption, ...translations]
      .filter((value) => typeof value === "string" && value.trim());
    const afterVoucher = localizedCaptions.some((copy) =>
      /(?:优惠后|優惠後|after\s+(?:the\s+)?voucher|selepas\s+baucar)/iu.test(copy) &&
      /(?:优惠券|優惠券|voucher|baucar)/iu.test(copy)
    );
    result.push({
      name: String(option.name).trim(), title: String(option.title || "").trim(),
      price: configured || unique[0], afterVoucher,
      // Optional explicit package unit evidence. "First Trial" or the model's
      // words do not prove that the amount covers exactly one session.
      ...(Number.isSafeInteger(structured?.sessionsIncluded) &&
        structured.sessionsIncluded >= 1 && structured.sessionsIncluded <= 20
        ? { sessionsIncluded: structured.sessionsIncluded } : {}),
    });
  }
  if (automatic.length === 1 && allowTextOnlyOffers) {
    const approved = new Set(result.map((item) => item.price));
    for (const other of related.filter(p => p !== matching[0])) {
      const otherOptions = promotionPackages(other);
      const hasPriceEvidence = otherOptions.some((option) =>
        Boolean(option.pricing?.offer) ||
        [option.caption, option.followUpMessage,
          ...Object.values(option.mediaTranslations || {}).map(x => x?.caption || x),
          ...Object.values(option.followUpTranslations || {}).map(x => x?.message || x)]
          .some(copy => /(?:RM|MYR)\s*\d{2,5}/iu.test(
            String(copy || "").normalize("NFKC").replace(/[\uFE0F\u20E3]/gu, "")
          ))
      );
      if (!hasPriceEvidence) continue;
      const otherPrices = verifiedPricesForService(
        treatment, [other], customerText, conversationHistory,
        { clarifiedPriceService, allowTextOnlyOffers: true }
      );
      if (!otherPrices?.length ||
          otherPrices.some(item => !approved.has(item.price))) return null;
    }
  }
  return result;
}

// A price should never replace a customer’s question about pain, safety or
// suitability. Use a short, deterministic acknowledgement instead of
// repeating unverified clinical assurances from the model draft.
function clinicalPricingAcknowledgement(customerText, language = "zh") {
  if (!hasClinicalMediaRisk(customerText)) return "";
  const pain = /(?:会不会很痛|會不會很痛|会不会痛|會不會痛|会痛吗|會痛嗎|痛不痛|疼不疼|疼痛|\b(?:pain\w*|hurt\w*|discomfort|uncomfortable|sakit)\b)/iu.test(
    String(customerText || "")
  );
  const locale = String(language || "").toLowerCase();
  if (locale.startsWith("ms")) {
    return pain
      ? "Tentang rasa sakit, pengalaman setiap orang berbeza. Pihak pusat boleh semak kesesuaian dan tahap keselesaan bersama anda dahulu; kami tidak boleh menjanjikan rawatan ini bebas sakit."
      : "Tentang keadaan dan kesesuaian rawatan, pihak pusat perlu menilai situasi anda dahulu sebelum memberi nasihat khusus.";
  }
  if (locale.startsWith("en")) {
    return pain
      ? "Regarding pain or discomfort, experiences vary. Our practitioner can discuss comfort and suitability after learning about your situation; we cannot guarantee a pain-free treatment."
      : "Regarding your health or treatment-suitability concern, our practitioner needs to understand your situation before giving individual guidance.";
  }
  return pain
    ? "至于会不会痛，每个人的感受都可能不同哦。建议先让中医师了解你的情况、评估是否适合，再向你说明护理过程，不能保证完全无痛。"
    : "关于你提到的身体情况或是否适合，建议先让中医师了解实际情况再评估，不能单凭聊天直接保证安全或效果哦。";
}

// An AI draft cannot commit the system to sending a graphic. Actual image
// permission is decided separately after the text is accepted, and may fail
// even when a promotion price is verified.
const MEDIA_SEND_PROMISE = /(?:我|我们|我們).{0,15}(?:发|發|传|傳|分享).{0,50}(?:图片|圖片|图|圖|照片|优惠|優惠|促销|促銷|资料|資料|详情|詳情)|(?:\b(?:i(?:'ll| will| can)?|we(?:'ll| will| can)?|sending)\b.{0,30}\b(?:send|share|forward|over)\b.{0,55}\b(?:image|photo|picture|promo|promotion|offer|graphic|details)\b)|(?:\b(?:saya|kami)\b.{0,20}\b(?:hantar|kongsikan)\b.{0,55}\b(?:gambar|promosi|tawaran)\b)/iu;
// A missing commercial candidate may restrict amounts and media without
// dictating conversational wording. Neutral price/fee terminology is not a
// price claim. Keep the existing numeric, offer, voucher and delivery vetoes.
// Zero-cost wording is a financial claim, even without an RM amount.
function hasComplimentaryPriceClaim(reply) {
  return /(?:免费|免費|免收费|免收費|不收(?:取)?(?:费用|費用|费|費|钱|錢)|(?:无|無|无需|無需|不用|不必|不需要|不需|免)(?:任何)?(?:付费|付費|付款|费用|費用|收费|收費|钱|錢)|(?:收费|收費|费用|費用|价钱|價錢|价格|價格)(?:为|為|是|等于|等於|:|：)?\s*(?:零|0)(?!\d)|零(?:费用|費用|收费|收費)|\b(?:free|complimentary|gratis|no\s+(?:additional\s+)?(?:charge|cost|fee|payment)s?|at\s+no\s+cost|zero\s+(?:charge|cost|fee)s?|without\s+(?:any\s+)?(?:charge|cost|fee|payment)|(?:do not|don't|does not|doesn't|need not|no need to)\s+(?:need to\s+|have to\s+)?pay|percuma|tanpa\s+(?:sebarang\s+)?(?:caj|bayaran|kos)|(?:tidak|tak)\s+(?:perlu\s+)?(?:bayar|dikenakan\s+caj)|(?:caj|bayaran|kos)\s*(?:sifar|kosong|0))\b)/iu.test(normalizeMoneyText(reply));
}
function isSafeUnquotedReply(reply) {
  const text=String(reply||"").trim();
  if(!text || hasTreatmentPriceContent(text) || scanMyrAmounts(text).length ||
      MEDIA_SEND_PROMISE.test(text) ||
      hasComplimentaryPriceClaim(text)) return false;
  // Unprefixed small amounts and spelled-out monetary claims are not
  // automatically neutral merely because they lack RM. A price discussion
  // containing quantities stays on the existing verification path.
  const priceTerms=/(?:[价價][钱錢格位]|收[费費]|[费費]用|\b(?:price|pricing|costs?|fees?|charges?|rates?|harga|bayaran|caj|kos)\b)/iu;
  if(priceTerms.test(text) && /(?:\p{N}|[零一二三四五六七八九十两兩百千万萬亿億]{2,}|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|satu|dua|tiga|empat|lima|enam|tujuh|lapan|sembilan|sepuluh|puluh|ratus|ribu)\b)/iu.test(text))return false;
  // Do not use this eligibility check to release an unsupported clinical
  // promise or an unverified payment/booking claim.
  if (hasClinicalMediaRisk(text) || /(?:保证|保證|一定.{0,12}(?:见效|見效|有效|治好)|包治|零恢复期|零恢復期|无需恢复|無需恢復|\b(?:guarantee[ds]?|cure[ds]?|zero downtime|no downtime|guaranteed results?|pasti sembuh|dijamin|tiada masa pemulihan)\b)/iu.test(text)) return false;
  const neutral=text.replace(/(?:[价價][钱錢格位]|收[费費]|[费費]用|\b(?:price|pricing|costs?|fees?|charges?|rates?|harga|bayaran|caj|kos)\b)/giu," ");
  if(hasCommercialReplyContent(neutral))return false;
  return !require("./unconfirmedMediaPromiseGuard").guardUnconfirmedMediaPromise(text).changed;
}
// Strictly scoped to the configured introductory offer. Permit natural
// wording/courtesy, but fail closed for any other service or factual clause.
function verifiedComplimentaryAssessmentDraft(reply,language="zh"){
  const text=String(reply||"").normalize("NFKC").trim();
  if(!text || scanMyrAmounts(text).length || MEDIA_SEND_PROMISE.test(text))return false;
  const clean=text.replace(/[\p{P}\p{S}\s]/gu," ").replace(/\s+/gu," ").trim();
  const zh=/^(?:(?:亲爱的|親愛的|您好|你好|是的|对的|對的|可以的|我们|我們|的)\s*)*(?:1\s*对\s*1|1\s*對\s*1|一对一|一對一)\s*(?:的\s*)?(?:体态评估|體態評估)\s*(?:加|和|及|与|與)?\s*(?:体验|體驗)\s*(?:是|都是|属于|屬於)?\s*(?:免费|免費|不收费|不收費)\s*(?:的|哦|呀|呢|啦|谢谢|謝謝)*$/u;
  const en=/^(?:(?:hi|hello|yes|of course|our|the|it is)\s+)*(?:1 on 1|one on one|1 to 1|one to one)\s+posture assessment\s+(?:and|plus|with)\s+(?:an?\s+)?(?:introductory\s+)?experience\s+(?:is|are)\s+(?:free|complimentary|at no cost|at no charge)(?:\s+(?:thank you|thanks))?$/iu;
  const ms=/^(?:(?:hai|ya|betul|kami|penilaian)\s+)*(?:penilaian postur\s+)?(?:1 ke 1|1 dengan 1|satu dengan satu)\s+(?:bersama|dan|dengan)\s+(?:sesi\s+)?(?:pengalaman\s+)?pengenalan\s+(?:adalah\s+)?(?:percuma|tanpa caj)(?:\s+ya)?$/iu;
  return (String(language).startsWith("en")?en:String(language).startsWith("ms")?ms:zh).test(clean);
}
// An accepted neutral reply need not repeat all approved prices before the
// already-authorized artwork can be selected. Never bypass mismatch for
// an actual monetary, free, offer or unconfirmed-delivery claim.
function allowsApprovedPromotionWithoutTextQuote({reply,decision}={}){
  return decision?.source==="model_led_customer_context" &&
    ["price","package_options"].includes(decision.type) &&
    Array.isArray(decision.prices) && decision.prices.length>0 &&
    isSafeUnquotedReply(reply);
}
function nonPriceExplanation(reply) {
  const clauses = String(reply || "").split(/\n+|(?<=[。！？!?])\s*/u);
  const kept = clauses.map((line) => line.trim()).filter((line) =>
    line && !MEDIA_SEND_PROMISE.test(line) &&
    !hasCommercialReplyContent(line) && !hasTreatmentPriceContent(line) &&
    !/(?:[价價][钱錢格位]|收费|收費|费用|費用|原价|原價|优惠|優惠|折扣|voucher|discount|\b(?:price|pricing|cost|harga|promosi)\b)/iu.test(line)
  );
  return kept.slice(0, 3).join("\n").slice(0, 340).trim();
}

// Compound price + session/duration questions must not retain model-authored
// session counts or guaranteed treatment outcomes (e.g. "三次一定见效").
// Offer deterministic, individualized assessment guidance instead.
// Recovery/downtime is a separate customer question even when a verified
// price must replace Gemini's original reply. Never promise zero downtime or
// prescribe an individual recovery period from a marketing conversation.
const RECOVERY_OR_DOWNTIME_QUESTION =
  /(?:修复期|修復期|恢复期|恢復期|康复期|康復期|修复时间|修復時間|恢复时间|恢復時間|(?:需要|需|要|是否需要)\s*休息\s*(?:多久|多长|多長|(?:几|幾|多少)\s*天|几日|幾日)?|\bdowntime\b|\brecovery\s*(?:time|period)?\b|\bhealing\s*(?:time|period)\b|\baftercare\b|\btime\s+to\s+recover\b|\b(?:masa|tempoh)\s+pemulihan\b|\bpemulihan\b)/iu;

function recoveryPeriodGuidance(customerText, language = "zh") {
  if (!RECOVERY_OR_DOWNTIME_QUESTION.test(String(customerText || ""))) return "";
  const locale = String(language || "zh").toLowerCase();
  if (locale.startsWith("ms")) {
    return "Tentang tempoh pemulihan, reaksi selepas rawatan berbeza mengikut individu. Kami tidak boleh menjamin tiada masa pemulihan. Pengamal boleh menilai kesesuaian serta terangkan penjagaan selepas rawatan dahulu.";
  }
  if (locale.startsWith("en")) {
    return "Regarding downtime or recovery, reactions vary by person and we cannot guarantee zero downtime. Our practitioner can assess your suitability and explain aftercare before treatment.";
  }
  return "至于修复期／恢复时间，每个人护理后的反应可能不同，不能保证完全没有恢复期哦。中医师会先评估是否适合，再说明护理后的注意事项。";
}

const SESSION_OR_DURATION_QUESTION =
  /(?:[几幾多]\s*(?:次|回|个疗程|個療程)|多少\s*(?:次|个疗程|個療程)|(?:要|需要)\s*做\s*(?:几|幾|多少)\s*次|(?:做|只做|护理|護理|调理|調理)\s*(?:一|1)\s*(?:次|回)\s*(?:就|可以|能|会)?\s*(?:行|好|够|夠|有效)(?:了|吗|嗎|呢|[?？])*|\b(?:is|will|would)\s+(?:one|1|a\s+single)\s+(?:session|treatment)\s+(?:be\s+)?(?:enough|sufficient)\b|多久|多长|多長|\bhow\s+many\s+sessions?\b|\bhow\s+long\b|\bberapa\s+(?:kali|sesi|lama)\b)/iu;

// A simple price quote cannot by itself answer a separately stated question.
// Reuse current enquiry classifiers rather than another treatment keyword list.
function hasSeparateNonPriceEnquiry(customerText){
  const current=stripFutureFollowUpPermission(String(customerText||"")).text;
  const clauses=(current.match(/[^?？。;；\n]+[?？。;；\n]*/gu)||[]).map(s=>s.trim()).filter(Boolean);
  // A customer can request price and treatment process in the same
  // sentence without punctuation. This preserves non-price explanatory
  // text; it is not a new source of commercial authorization.
  if(hasExplicitPriceRequest(current)&&
    /(?:了解.{0,18}(?:过程|過程|流程)|(?:过程|過程|流程).{0,10}(?:价格|價格|价钱|價錢)|怎么做|怎麼做|如何进行|如何進行|\b(?:how (?:does it work|is it done)|treatment process|procedure details|proses rawatan|cara rawatan)\b)/iu.test(current))return true;
  if(clauses.length<2)return false;
  const {isCurrentOfferEnquiry}=require("./currentOfferEnquiry");
  const commercial=part=>hasExplicitPriceRequest(part)||isStandalonePriceQuestion(part)||
    hasExplicitPackageOptionsRequest(part)||isCurrentOfferEnquiry(part);
  return clauses.some(commercial)&&clauses.some(part=>!commercial(part)&&
    (/[?？]/u.test(part)||hasCustomerServiceEnquiry(part)));
}

// Match complete MYR amounts, not a substring of another amount. This only
// identifies a quoted fact AFTER independent commercial authorization.
function containsApprovedPriceAmount(reply,decision){
  if(!decision)return false;
  const amounts=new Set([...(Array.isArray(decision.prices)?decision.prices:[]).map(item=>item?.price),
    decision.servicePrice].filter(value=>/^RM[1-9]\d{0,5}$/u.test(String(value||""))).map(value=>Number(value.slice(2))));
  return scanMyrAmounts(reply).some(claim=>amounts.has(claim.amount));
}

function configuredDurationAnswer(customerText,service,language,prices){
 const q=String(customerText||"");
 if(!/(?:疗程多久|療程多久|护理多久|護理多久|做多久|一次多久|需要多久|需要多长时间|需要多長時間|疗程时间|療程時間|\b(?:how long|duration|berapa lama|tempoh rawatan)\b)/iu.test(q)||
   /(?:恢复|恢復|修复|修復|多久见效|多久見效|downtime|recover|results?|pemulihan)/iu.test(q)||
   !service||!Array.isArray(prices)||prices.some(p=>p.name!=="Main offer"))return "";
 // Only exact, unqualified configured durations can be localized here.
 // Package-specific, promotional or qualified durations stay on their
 // existing verified copy path rather than being reinterpreted.
 const raw=String(service.duration||"").trim();
 const m=raw.match(/^(约|約)?(?:(\d{1,2})\s*(?:小时|小時))?(?:(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*(?:分钟|分鐘))?$/u);
 if(!m||(!m[2]&&!m[3])||m[4]&&m[2])return "";
 const hr=Number(m[2]||0),min=Number(m[3]||0),end=m[4]?Number(m[4]):null;
 if(hr>12||min>180||end!==null&&(end<min||end>180))return "";
 const en=String(language).startsWith("en"),ms=String(language).startsWith("ms");
 const amount=en?[hr?hr+" hour"+(hr!==1?"s":""):"",min?(end!==null?min+"–"+end:min)+" minutes":""].filter(Boolean).join(" "):
  ms?[hr?hr+" jam":"",min?(end!==null?min+"–"+end:min)+" minit":""].filter(Boolean).join(" "):raw;
 return en?"The configured treatment duration is "+(m[1]?"about ":"")+amount+".":ms?"Tempoh rawatan "+(m[1]?"kira-kira ":"ialah ")+amount+".":"这项护理的时间"+amount+"。";
}
function safeNonPriceExplanation(customerText, original, language, service=null,prices=[]) {
  const recovery = recoveryPeriodGuidance(customerText, language);
  if (recovery) return recovery;
  const duration=configuredDurationAnswer(customerText,service,language,prices);
  if(duration)return duration;
  if (!SESSION_OR_DURATION_QUESTION.test(String(customerText || ""))) {
    return nonPriceExplanation(original);
  }
  const locale = String(language || "zh").toLowerCase();
  if (locale.startsWith("ms")) {
    return "Bilangan sesi atau tempoh rawatan bergantung pada keadaan individu dan perlu dinilai oleh pengamal terlebih dahulu.";
  }
  if (locale.startsWith("en")) {
    return "The number of sessions or treatment duration depends on your individual needs and should be assessed by the practitioner.";
  }
  return "具体做几次需要中医师评估后确认，护理时间也会根据个人情况而有所不同。";
}

// Preserve a complete, simple AI-authored quote when all its commercial
// claims can be verified locally. More elaborate wording, additional terms,
// unsupported clinical claims or missing conditions use the existing formatter.
// This is a text validation step, not another intent classifier.
function preserveVerifiedModelQuote({reply,treatment,prices,firstTrialQuote}={}) {
  const original=String(reply||"").trim();
  if (!original || original.length>400 || !prices?.length ||
      hasClinicalMediaRisk(original) || MEDIA_SEND_PROMISE.test(original)) return null;
  const normalized=normalizeMoneyText(original);
  const amounts=scanMyrAmounts(normalized);
  if(amounts.length!==prices.length ||
     !normalized.includes(treatment.normalize("NFKC"))) return null;
  let residual=normalized.replace(treatment.normalize("NFKC")," ");
  // A package quotation must name each approved option next to its exact
  // amount. Do not retain a menu just because the numeric set matches.
  if(prices.length===1 && prices[0].name==="Main offer"){
    if(amounts[0].amount===null || "RM"+amounts[0].amount!==prices[0].price || prices[0].afterVoucher)return null;
    residual=residual.replace(amounts[0].raw," ");
  }else{
    if(prices.some(p=>p.name==="Main offer" || p.afterVoucher))return null;
    const lines=normalized.split(/\n+/u);
    for(const p of prices){
      const name=p.name.normalize("NFKC");
      const matches=lines.filter(line=>line.includes(name));
      if(matches.length!==1)return null;
      const line=matches[0];
      if(prices.filter(other=>line.includes(other.name.normalize("NFKC"))).length!==1)return null;
      const money=scanMyrAmounts(line);
      if(money.length!==1 || money[0].amount===null || "RM"+money[0].amount!==p.price)return null;
      residual=residual.replace(name," ").replace(money[0].raw," ");
    }
  }
  // Preserve natural connectors around verified facts. Unverified gifts,
  // deadlines, session counts, efficacy claims and voucher terms fall back
  // to the configured formatter rather than being released unchecked.
  const trial=/(?:first\s*trial|首次体验|首次體驗|初次体验|初次體驗|体验优惠价|體驗優惠價|percubaan pertama)/iu.test(normalized);
  if(firstTrialQuote!==trial) return null;
  const connectors=/(?:亲爱的|親愛的|您好|你好|是的|好的|我们|我們|目前|现在|現在|首次体验|首次體驗|初次体验|初次體驗|体验优惠价|體驗優惠價|体验价|體驗價|优惠价|優惠價|价格|價格|价钱|價錢|只需|仅需|僅需|以下|有两个|有兩個|两个|兩個|配套|套餐|优惠|優惠|的|是|为|為|哦|呀|呢|啦|哈|first\s*trial|percubaan pertama|\b(?:hi|hello|dear|yes|of course|currently|now|our|the|for|is|are|at|only|price|prices|package|packages|options|promotional|promo|harga|promosi|pakej|pilihan|untuk|ialah|adalah|semasa|hanya|ya|awak|anda|kami)\b)/giu;
  residual=residual.replace(/[\p{P}\p{S}\s]/gu," ").replace(connectors,"").trim();
  if(residual)return null;
  return original;
}

// Preserve a bounded multi-service quote only when every line independently
// passes the same fact validator as a single quote. No inferred price, voucher
// condition, combined package or treatment identity can be added by the model.
function preserveVerifiedTwoTreatmentDraft({reply,quote,customerText,promotions,conversationHistory,services=[],serviceAliases=[]}={}){
  if(quote?.source!=="verified_two_separate_treatments" ||
     !Array.isArray(quote.prices) || quote.prices.length!==2 ||
     new Set(quote.prices.map(p=>p.treatment)).size!==2 ||
     hasSeparateNonPriceEnquiry(customerText) || hasClinicalMediaRisk(customerText))return null;
  const value=String(reply||"");
  if(!value.trim() || value.length>400)return null;
  const normalized=normalizeMoneyText(value);
  if(scanMyrAmounts(normalized).length!==2)return null;
  // Only split at genuine clause separators, not decimal points or grouped
  // monetary commas. Each price must remain paired with one configured service.
  const candidates=serviceCandidates(services.length?services:quote.prices.map(p=>({name:p.treatment})),serviceAliases);
  const parts=normalized.split(/\r?\n|[;；。！!?？]|(?<!\d)[,，]|[,，](?!\d)|\b(?:and|dan)\b|以及|还有|還有|而|(?<=\d)\.(?!\d)/giu)
    .map(part=>part.trim()).filter(Boolean);
  const monetary=parts.filter(part=>scanMyrAmounts(part).length);
  if(monetary.length!==2)return null;
  const nonFact=/^(?:(?:hi|hello|dear|yes|of course|sure|here are (?:the )?(?:prices|offers)(?: for (?:both|the two) (?:separate )?treatments)?|these are (?:separate|individual) (?:prices|offers|treatment offers)|both prices are separate|not a (?:combo|combination) (?:package|offer)|hai|baik|boleh|harga (?:untuk )?(?:kedua-dua )?rawatan(?: berasingan)?|ini harga (?:rawatan )?berasingan|bukan pakej gabungan|您好|你好|亲爱的|親愛的|好的|可以的|当然可以|當然可以|两项(?:护理|療程|疗程|護理)?(?:分开|分開|各自)的?价格|兩項(?:護理|療程)?(?:分開|各自)的?價格|以上是(?:两项|兩項)?(?:分开|分開|各自)的?优惠|不是组合配套|不是組合配套)[\s\p{P}\p{S}]*|[\s\p{P}\p{S}]+)$/iu;
  if(parts.some(part=>!scanMyrAmounts(part).length&&!nonFact.test(part)))return null;
  const used=new Set();
  for(const entry of quote.prices){
    if(!["first_trial","current_offer"].includes(entry.label))return null;
    const verified=verifiedPricesForService(entry.treatment,promotions,customerText,conversationHistory,
      {allowTextOnlyOffers:true});
    if(verified?.length!==1 || verified[0].afterVoucher ||
       verified[0].price!==entry.amount || verified[0].sessionsIncluded>1)return null;
    const candidate=candidates.find(item=>item.name===entry.treatment);
    if(!candidate)return null;
    const matches=monetary.filter(part=>{
      const names=findServicesInText(part,candidates);
      return names.length===1&&names[0]===entry.treatment;
    });
    if(matches.length!==1||used.has(matches[0]))return null;
    // Replace a single unambiguous configured alias only for validation;
    // return the untouched original wording if all facts are approved.
    const part=matches[0];
    const terms=candidate.terms.map(item=>item.value.normalize("NFKC")).sort((a,b)=>b.length-a.length);
    let canonical=null;
    for(const term of terms){
      const escaped=term.replace(/[.*+?^$(){}|[\]\\]/gu,"\\$&");
      const pattern=new RegExp((/^[a-z0-9]/iu.test(term)?"(?<![a-z0-9])":"")+escaped+
        (/[a-z0-9]$/iu.test(term)?"(?![a-z0-9])":""),"iu");
      if(pattern.test(part)){
        canonical=part.replace(pattern,()=>entry.treatment);
        break;
      }
    }
    if(!canonical || !preserveVerifiedModelQuote({reply:canonical,treatment:entry.treatment,
      prices:[{name:"Main offer",price:entry.amount}],firstTrialQuote:entry.label==="first_trial"}))return null;
    used.add(part);
  }
  return value;
}

// If Gemini ignores an already verified price question, reply using active
// configured package prices. Do not depend on optional images being sent: the
// WhatsApp RM0 gate may suppress media while still allowing the text answer.
function ensureVerifiedPriceReply({
  customerText, reply, treatment, clarifiedPriceService = null,
  verifiedNumberedSelection = null, verifiedShadowPriceService = null,
  pricingDecision = undefined,
  priceRequested = false, priceOnlyResponse = false,
  services = [], serviceAliases = [], promotions = [],
  resultMedia = [], conversationHistory = [], language = "zh",
  allowContinuedPriceContext = false, preserveNaturalReply = false,
  verifiedTwoTreatmentQuote = null, aiFirstReplyAuthority = false,
} = {}) {
  const original = String(reply || "").trim();
  // The clinic explicitly offers the introductory assessment + experience
  // free of charge. A normal service price fallback must never turn this
  // administrative question into a "please confirm the fee" response.
  if (isComplimentaryAssessmentFeeQuestion(
    customerText,
    clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true,
    conversationHistory
  )) {
    const verifiedFee = complimentaryAssessmentFeeReply(language);
    // Only preserve a bounded affirmative assessment-only statement: no
    // extra claims about paid treatment, sessions, offers or booking.
    if(aiFirstReplyAuthority && verifiedComplimentaryAssessmentDraft(original,language))
      return {reply:original,restored:false};
    return { reply: verifiedFee, restored: !preserveNaturalReply || original !== verifiedFee };
  }
  if(preserveNaturalReply && verifiedTwoTreatmentQuote?.source==="verified_two_separate_treatments"){
    const natural=preserveVerifiedTwoTreatmentDraft({reply,quote:verifiedTwoTreatmentQuote,
      customerText,promotions,conversationHistory,services,serviceAliases});
    return {reply:natural ?? verifiedTwoTreatmentQuote.reply,
      restored:natural===null,verifiedQuote:true};
  }
  const aiLed = pricingDecision !== undefined;
  // In enabled mode the same independently verified decision drives text and
  // images. No price decision must not leave an invented quote or a promise to
  // send promotion media in the AI text.
  if (aiLed && (!pricingDecision || pricingDecision.treatment !== treatment)) {
    // The numbered menu itself verifies a treatment, but a missing or
    // conflicting active price must never leave a placeholder unfulfilled or
    // ask which treatment the customer chose again.
    if (verifiedNumberedSelection && verifiedNumberedSelection === treatment) {
      const locale = String(language || "").toLowerCase();
      return {
        reply: locale.startsWith("ms")
          ? `Harga terkini untuk ${treatment} perlu disahkan oleh pihak pusat dahulu ya 😊`
          : locale.startsWith("en")
            ? `Our centre needs to confirm the current price for ${treatment} 😊`
            : `${treatment} 的最新价格需要由门店帮你确认哦 😊`,
        restored: true,
      };
    }
    // Non-price service replies must remain intact. Only remove a genuinely
    // unsolicited numeric price or a promise of promotional media that may
    // never pass the provider's separate delivery checks.
    const mediaPromise = MEDIA_SEND_PROMISE.test(original);
    const unsolicitedAmount = hasTreatmentPriceContent(original);
    const unverifiedFree = aiFirstReplyAuthority && hasComplimentaryPriceClaim(original);
    if (!priceRequested && !mediaPromise && !unsolicitedAmount && !unverifiedFree) {
      return { reply: original, restored: false };
    }
    const needsFactualCorrection = Boolean(recoveryPeriodGuidance(customerText,language)) ||
      SESSION_OR_DURATION_QUESTION.test(String(customerText||"")) ||
      hasClinicalMediaRisk(customerText) || hasClinicalMediaRisk(original);
    // Do not retain unsupported complimentary claims in the fallback prose.
    const safeText = unverifiedFree ? "" : safeNonPriceExplanation(customerText, original, language);
    const locale = String(language || "").toLowerCase();
    if (!priceRequested) {
      const fallback = locale.startsWith("ms") ? "Boleh saya bantu terangkan rawatan ini 😊"
        : locale.startsWith("en") ? "I can help explain this treatment 😊"
          : "我可以先帮你介绍这项疗程哦 😊";
      return { reply: safeText || fallback, restored: true };
    }
    const question = locale.startsWith("ms")
      ? "Harga untuk rawatan yang mana satu ya? Saya boleh bantu semak 😊"
      : locale.startsWith("en")
        ? "Which treatment would you like the price for? I can help check 😊"
        : "请问你想了解哪项疗程的价格呢？我帮你确认 😊";
    return { reply: [safeText, question].filter(Boolean).join("\n\n"), restored: true,
      // Mark only a genuinely optional clarification. The caller cannot
      // restore a draft after a factual/safety correction.
      optionalClarification: !needsFactualCorrection && !unverifiedFree &&
        !mediaPromise && !unsolicitedAmount && isSafeUnquotedReply(original) };
  }
  // A verified customer-selected pelvic treatment remains the pricing
  // anchor through a short postpartum *concern* answer. The generic
  // related-treatment guard otherwise mistakes "产后体态" for a request to
  // switch to the separate, unpriced 产后调理 service.
  const verifiedContinuedService =
    (aiLed && pricingDecision?.treatment === treatment) ||
    verifiedNumberedSelection === treatment ||
    verifiedShadowPriceService === treatment ||
    resolveRecentFirstTreatmentPriceService({
      customerText, conversationHistory, services, serviceAliases, promotions,
    })?.name === treatment ||
    (allowContinuedPriceContext === true &&
      resolveContinuedTreatmentPriceService({
        customerText, conversationHistory, services, serviceAliases, promotions,
      })?.name === treatment);
  if (!original || !treatment ||
      !(aiLed ||
        hasExplicitPriceRequest(customerText, { treatment }) ||
        clarifiedPriceService === treatment) ||
      (!verifiedContinuedService && relatedPricingConflict({
        customerText, treatment, conversationHistory, services, serviceAliases,
        resultMedia,
      })) ||
      (!verifiedContinuedService && unpricedRelatedPrimary({
        customerText, conversationHistory, services, serviceAliases, resultMedia,
      }))) return { reply: original, restored: false };

  const prices = aiLed
    ? pricingDecision.prices
    : verifiedPricesForService(treatment, promotions, customerText, conversationHistory, {
        clarifiedPriceService,
      });
  const locale = String(language || "").toLowerCase();
  if (!Array.isArray(prices) || prices.length === 0) {
    // Text-only service prices remain valid when the clinic has not configured
    // a promotion. This fallback can never authorize a promotional graphic.
    if (aiLed && pricingDecision.servicePrice) {
      const locale = String(language || "").toLowerCase();
      const text = locale.startsWith("ms")
        ? `Harga untuk ${treatment}: ${pricingDecision.servicePrice} 😊`
        : locale.startsWith("en")
          ? `The price for ${treatment} is ${pricingDecision.servicePrice} 😊`
          : `${treatment} 的价格是 ${pricingDecision.servicePrice} 😊`;
      const recovery = recoveryPeriodGuidance(customerText, language);
      // A simple exact configured service-price answer can retain model wording.
      const preserved = preserveNaturalReply && !recovery && !hasClinicalMediaRisk(customerText) &&
        !hasSeparateNonPriceEnquiry(customerText) &&
        !SESSION_OR_DURATION_QUESTION.test(String(customerText || ""))
        ? preserveVerifiedModelQuote({reply:original,treatment,prices:[{name:"Main offer",price:pricingDecision.servicePrice}],firstTrialQuote:false})
        : null;
      if(preserved) return {reply:preserved,restored:false,verifiedQuote:true};
      const otherAnswer=preserveNaturalReply && !hasClinicalMediaRisk(customerText) &&
        (hasSeparateNonPriceEnquiry(customerText)||SESSION_OR_DURATION_QUESTION.test(String(customerText||"")))
        ? safeNonPriceExplanation(customerText,original,language,services.find(s=>s.name===treatment),[]) : "";
      return { reply: [text, recovery||otherAnswer].filter(Boolean).join("\n\n"), restored: true };
    }
    const safeInfo = recoveryPeriodGuidance(customerText, language) ||
      (hasClinicalMediaRisk(customerText) ? "" : safeNonPriceExplanation(customerText, original, language));
    const confirm = locale.startsWith("ms")
      ? "Harga rawatan ini perlu disahkan oleh pihak pusat ya."
      : locale.startsWith("en")
        ? "Our centre needs to confirm the current treatment price."
        : "这项疗程的最新价格需要由门店帮你确认哦。";
    const acknowledgement = clinicalPricingAcknowledgement(customerText, language);
    const parts = [safeInfo, confirm, acknowledgement].filter(Boolean);
    return { reply: parts.join("\n\n"), restored: true };
  }
  // The active configuration, not the AI draft, names Neutro's 3D/9D
  // promotional price as a First Trial. A one-off trial must not be labelled
  // as a recurring package or a subsequent-session rate.
  const firstTrialQuote = prices.length === 1 && getActivePromotions(promotions).some(p =>
    p?.linkedService === treatment && p?.sendOnPriceQuery === true &&
    /\bfirst[\s-]*trial\b/iu.test(String(p.name || ""))
  );
  // "RM488 for one time?" follows a previously sent, verified offer.
  // Answer the customer's session-price confirmation directly instead of
  // producing another generic price menu or promising to resend an image.
  if (aiLed && pricingDecision.source === "confirmed_prior_quote" &&
      prices.length === 1) {
    const item = prices[0];
    const amount = item.price;
    const namedPackage = item.name !== "Main offer" ? ` ${item.name}` : "";
    const offerName = `${treatment}${namedPackage}`;
    const asksForOneSession = /(?:for|per|is\s+for)\s*(?:one|1|a)\s*(?:time|session|treatment|visit)|(?:一|1)次(?:护理|護理|疗程|療程)?/iu
      .test(String(customerText || ""));
    // Never infer per-session billing from a confirmed amount. A configured
    // sessionsIncluded value is the only supported quantity authority.
    const verifiedSessions = Number.isSafeInteger(item.sessionsIncluded)
      ? item.sessionsIncluded : null;
    const unitNote = !asksForOneSession ? ""
      : verifiedSessions === 1
        ? locale.startsWith("ms") ? " Pakej ini merangkumi satu sesi."
          : locale.startsWith("en") ? " This package covers one session."
            : " 这个配套包含一次护理。"
        : verifiedSessions !== null
          ? locale.startsWith("ms") ? ` Pakej ini merangkumi ${verifiedSessions} sesi.`
            : locale.startsWith("en") ? ` This package covers ${verifiedSessions} sessions.`
              : ` 这个配套包含 ${verifiedSessions} 次护理。`
          : locale.startsWith("ms")
            ? " Pihak pusat boleh sahkan bilangan sesi yang termasuk dalam pakej ini."
            : locale.startsWith("en")
              ? " Our centre can confirm how many sessions are included in this package."
              : " 这个配套包含几次护理，需要由门店确认哦。";
    const voucherNote = item.afterVoucher
      ? locale.startsWith("ms")
        ? ` Harga ${item.name === "Main offer" ? treatment : item.name} adalah selepas baucar.`
        : locale.startsWith("en")
          ? ` The listed ${item.name === "Main offer" ? treatment : item.name} price is after applying the voucher.`
          : ` ${item.name === "Main offer" ? treatment : item.name} 的上述价格为使用优惠券后的价格。`
      : "";
    const answer = firstTrialQuote
      ? (locale.startsWith("ms")
        ? `Ya, harga promosi First Trial untuk ${treatment} ialah ${amount} 😊${unitNote}${voucherNote}`
        : locale.startsWith("en")
          ? `Yes, the First Trial promotional price for ${treatment} is ${amount} 😊${unitNote}${voucherNote}`
          : `是的，${treatment} 的 First Trial 体验优惠价是 ${amount} 😊${unitNote}${voucherNote}`)
      : locale.startsWith("ms")
        ? `Ya, harga promosi semasa untuk ${offerName} ialah ${amount} 😊${unitNote}${voucherNote}`
        : locale.startsWith("en")
          ? `Yes, the current ${offerName} package offer is ${amount} 😊${unitNote}${voucherNote}`
          : `是的，${offerName} 目前的配套优惠价是 ${amount} 😊${unitNote}${voucherNote}`;
    // A verified earlier amount answers the price only. Preserve a fresh
    // recovery question without inferring a fixed downtime or session count.
    const recovery = recoveryPeriodGuidance(customerText, language);
    return { reply: [answer, recovery].filter(Boolean).join("\n\n"), restored: true };
  }
  const entries = prices.map((item) =>
    `• ${item.name === "Main offer" ? treatment : item.name}${item.title && item.name !== "Main offer" ? `（${item.title}）` : ""}：${item.price}`
  ).join("\n");
  const voucherPackages = prices.filter((price) => price.afterVoucher)
    .map((price) => price.name === "Main offer" ? treatment : price.name);
  const voucherNames = voucherPackages.join(", ");
  const voucherNote = voucherPackages.length
    ? (locale.startsWith("ms")
      ? `Harga ${voucherNames} adalah selepas baucar`
      : locale.startsWith("en")
        ? `The listed price for ${voucherNames} is after applying the voucher`
        : `${voucherNames} 的上述价格为使用优惠券后的价格`)
    : "";
  const otherQuestion=preserveNaturalReply && hasSeparateNonPriceEnquiry(customerText);
  const canPreserveCompleteQuote=!preserveNaturalReply || (!otherQuestion &&
    !hasClinicalMediaRisk(customerText) && !recoveryPeriodGuidance(customerText,language) &&
    !SESSION_OR_DURATION_QUESTION.test(String(customerText||"")));
  const preservedModelQuote = aiLed && canPreserveCompleteQuote &&
    (pricingDecision.source === "model_led_customer_context" ||
      (preserveNaturalReply && pricingDecision.source === "customer_current_offer"))
    ? preserveVerifiedModelQuote({reply:original,treatment,prices,firstTrialQuote})
    : null;
  if (preservedModelQuote) return {reply:preservedModelQuote,restored:false,...(preserveNaturalReply?{verifiedQuote:true}:{})};
  const quote = firstTrialQuote &&
    !(aiLed && pricingDecision.source === "model_led_customer_context" && prices[0].name !== "Main offer")
    ? (locale.startsWith("ms")
      ? `Harga promosi First Trial untuk ${treatment}: ${prices[0].price} 😊`
      : locale.startsWith("en")
        ? `The First Trial promotional price for ${treatment} is ${prices[0].price} 😊`
        : `${treatment} 的 First Trial 体验优惠价是 ${prices[0].price} 😊`)
    : locale.startsWith("ms")
      ? `Untuk ${treatment}, harga promosi terkini ialah:\n${entries}${voucherNote ? "\n\n" + voucherNote : ""} 😊`
      : locale.startsWith("en")
        ? `The current ${treatment} package prices are:\n${entries}${voucherNote ? "\n\n" + voucherNote : ""} 😊`
        : `${treatment}目前的配套价格是：\n${entries}${voucherNote ? "\n\n" + voucherNote : ""} 😊`;
  // A clinical/suitability question may need staff input. Do not reproduce
  // potentially unsafe model claims about pain, pregnancy or eligibility;
  // quote verified prices independently without authorizing marketing media.
  // For an ad-anchored short price question, discard a model-generated
  // "which treatment?" clarification. The verified quote already answers it.
  // A verified, customer-selected package-list continuation must not
  // re-append Gemini's unrelated clinic-wide service catalog.
  // Preserve the second question using deterministic clinical guidance,
  // not an unchecked model efficacy or fixed-session promise.
  const recoveryGuidance = recoveryPeriodGuidance(customerText, language);
  const independentServiceQuestion =
    SESSION_OR_DURATION_QUESTION.test(String(customerText || "")) ||
    Boolean(recoveryGuidance) || otherQuestion;
  const explanation = recoveryGuidance ||
    (hasClinicalMediaRisk(customerText) ||
      ((priceOnlyResponse === true ||
        (aiLed && ["meta_ad", "customer_current_offer"].includes(pricingDecision.source))) && !independentServiceQuestion)
      ? "" : safeNonPriceExplanation(customerText, original, language,preserveNaturalReply?services.find(s=>s.name===treatment):null,prices));
  const bothQuestion = aiLed && pricingDecision.source === "customer_concern_both"
    ? (locale.startsWith("ms")
      ? "Saya boleh sahkan harga rawatan ini dahulu. Bila sebut kedua-dua, adakah anda maksudkan dua rawatan berbeza atau dua bahagian yang ingin diperbaiki?"
      : locale.startsWith("en")
        ? "I can confirm this treatment's price first. By both, did you mean two different treatments or two concerns within this treatment?"
        : "先给你这项疗程的核实价格 😊 你说的两项是指两种不同疗程，还是想改善的两个部位呢？")
    : "";
  const acknowledgement = clinicalPricingAcknowledgement(customerText, language);
  // An independently approved current promotion request deserves a clear
  // answer and one next-step invitation, not the earlier generic AI fallback.
  const offerInvitation = aiLed && pricingDecision.source === "customer_current_offer" &&
    !preserveNaturalReply && !independentServiceQuestion
    ? locale.startsWith("ms")
      ? "Nak tahu apa yang termasuk, atau mahu saya bantu semak masa untuk penilaian? 😊"
      : locale.startsWith("en")
        ? "Would you like to know what's included, or shall I help you arrange an assessment? 😊"
        : "想了解优惠包含什么，还是我帮你看看方便安排评估的时间呢？😊"
    : "";
  // When a general service word in the ad (e.g. 徒手整骨) anchors a
  // specifically advertised pelvic promotion, make that scope explicit.
  // This is price context, NOT a claim that the treatment fits symptoms.
  const adScope = aiLed && pricingDecision.source === "meta_ad" &&
    safeServiceFromCustomer(customerText, services, serviceAliases)?.name !== treatment
    ? locale.startsWith("ms")
      ? `Jika awak maksudkan rawatan ${treatment} dalam iklan kami, ini harga pakej yang ditawarkan 😊`
      : locale.startsWith("en")
        ? `If you're asking about ${treatment} in our advertisement, these are its current package prices 😊`
        : `如果你问的是我们广告里的${treatment}，目前有这些配套可以参考哦 😊`
    : "";
  // For model-led pricing, answer the requested price first, then retain
  // safe non-commercial wording from the same Gemini draft. Configured
  // amounts, trial labels and voucher conditions never come from free text.
  const parts = aiLed && pricingDecision.source === "model_led_customer_context"
    ? [quote, explanation, acknowledgement]
    : [adScope, explanation, quote, bothQuestion, acknowledgement, offerInvitation];
  return { reply: parts.filter(Boolean).join("\n\n"), restored: true };
}

// A model draft can claim "Here are the regular prices:" yet contain no
// actual price. A rejected pricing decision must not leak an unfinished quote
// to a customer. This guard never supplies unverified numeric amounts.
const UNFULFILLED_PRICE_HEADING =
  /(?:给你|給你|供你|参考|參考|提供|以下|如下|here\s+are|these\s+are|current|regular|standard|normal).{0,65}(?:价钱|價錢|价格|價格|收费|收費|regular\s+price|prices?|harga).{0,24}[:：]/iu;
// The model may output a bare service-specific heading ("9D 的价格是：")
// with no number. It must not escape the guard merely because it omitted
// "here are" / "给你参考". Restrict to a real heading ending in a colon.
const DIRECT_EMPTY_PRICE_HEADING =
  /(?:^|[\n。；;!?！？])\s*[^\n:：]{0,75}?(?:价钱|價錢|价格|價格|收费|收費|费用|費用|(?:the\s+)?prices?(?:\s+(?:for|of)\s+[^\n:：]{1,45})?|(?:regular|normal|first[\s-]?trial)\s+price|harga(?:\s+[^\n:：]{0,35})?)\s*(?:是|为|為|如下|is|are)?\s*[:：]/iu;
const UNFULFILLED_MULTIPLE_PRICES =
  /(?:两|兩|2)\s*(?:项|項|个|個|种|種)|\b(?:both|two\s+(?:treatments?|packages?|prices?))\b/iu;

// A price heading is not fulfilled by a voucher face value or the price of
// an unrelated treatment later in the draft. Evaluate EACH heading and its
// adjacent price section instead of accepting any RM amount anywhere.
const VISIBLE_MONETARY_AMOUNT =
  /\b(?:RM|MYR)\s*[1-9]\d{1,5}(?:\.\d{2})?\b|(?:[价價](?:格|钱|錢)|收费|收費|费用|費用|harga|prices?|cost|fee)\s*(?:是|为|為|is|are)?\s*[:：]?\s*[1-9]\d{2,5}(?!\d)/giu;
const VOUCHER_PREFIX = /(?:优惠券|優惠券|折扣券|抵用券|voucher|coupon|baucar)\s*(?:面额|面額|价值|價值|worth|of)?\s*[:：]?\s*$/iu;
const VOUCHER_SUFFIX = /^\s*(?:的)?\s*(?:优惠券|優惠券|折扣券|抵用券|voucher|coupon|baucar|off\b)/iu;
const NAMED_PRICE_TREATMENT = /(?:3D|9D|骨盆(?:调理|調理)?)/giu;
const PRICE_HEADING_PATTERN = new RegExp(
  "(?:" + UNFULFILLED_PRICE_HEADING.source + ")|(?:" +
  DIRECT_EMPTY_PRICE_HEADING.source + ")", "giu"
);
function hasVerifiedAmountForHeading(section, heading) {
  const matches = [...section.matchAll(VISIBLE_MONETARY_AMOUNT)];
  const headedServices = [...new Set([...heading.matchAll(NAMED_PRICE_TREATMENT)]
    .map(m => m[0].toLowerCase()))];
  return matches.some(match => {
    const before = section.slice(Math.max(0, match.index - 30), match.index);
    const after = section.slice(match.index + match[0].length,
      match.index + match[0].length + 30);
    // The label immediately before/after a voucher amount disqualifies it,
    // including "RM100 优惠券" and "voucher RM100".
    const localBefore = before.split(/\n/u).at(-1);
    const localAfter = after.split(/\n/u)[0];
    if (VOUCHER_PREFIX.test(localBefore) || VOUCHER_SUFFIX.test(localAfter)) return false;
    if (headedServices.length === 1) {
      // "9D price: 3D RM488" does NOT answer the 9D enquiry.
      const line = section.slice(section.lastIndexOf("\n", match.index - 1) + 1,
        section.indexOf("\n", match.index) < 0 ? section.length : section.indexOf("\n", match.index));
      const quotedServices = [...new Set([...line.matchAll(NAMED_PRICE_TREATMENT)]
        .map(m => m[0].toLowerCase()))];
      if (quotedServices.some(name => name !== headedServices[0])) return false;
    }
    return true;
  });
}
function checkUnfulfilledPriceQuote(reply, language = "zh") {
  const original = String(reply || "").trim();
  const headings = [...original.matchAll(PRICE_HEADING_PATTERN)];
  if (!headings.length) return { reply: original, changed: false };
  const isUnfulfilled = headings.some((heading, index) => {
    const sectionStart = heading.index + heading[0].length;
    const nextHeading = headings[index + 1]?.index ?? original.length;
    // A remote quote or a footnote does not fulfill an earlier empty heading.
    const section = original.slice(sectionStart, Math.min(nextHeading, sectionStart + 280));
    return !hasVerifiedAmountForHeading(section, heading[0]);
  });
  if (!isUnfulfilled) return { reply: original, changed: false };
  const locale = String(language || "").toLowerCase();
  const comparingTwo = UNFULFILLED_MULTIPLE_PRICES.test(original);
  // Never fabricate an amount. Ambiguity about "both" is a separate case:
  // do not ask about two treatments when the customer never mentioned two.
  const safe = locale.startsWith("ms")
    ? (comparingTwo
      ? "Saya faham anda mahu tahu kedua-dua harga 😊 Jumlah yang sah belum dapat disahkan. Adakah anda maksudkan dua rawatan atau dua masalah dalam satu rawatan?"
      : "Saya faham anda mahu tahu harga 😊 Jumlah yang sah belum dapat disahkan, jadi saya tak mahu beri angka yang salah. Rawatan yang mana satu anda ingin semak?")
    : locale.startsWith("en")
      ? (comparingTwo
        ? "I understand you'd like both prices 😊 I don't have a verified amount to quote. Are you comparing two treatments or two concerns within one treatment?"
        : "I understand you'd like the price 😊 I don't have a verified amount to quote, so I don't want to give you the wrong figure. Which treatment would you like me to check?")
      : (comparingTwo
        ? "明白，你想先了解价钱 😊 目前还没有核对好的金额，我不想给错报价。你说的两项，是想比较两种疗程，还是同一疗程针对两个部位呢？"
        : "明白，你想了解价钱 😊 目前还没有核对好的金额，我不想给错报价。你想查询哪项疗程的价格呢？");
  return { reply: safe, changed: true };
}

// Neutro's commercial output boundary runs the existing delivery-claim and
// empty-quote checks together, in their established order. Separate audit
// reasons are retained; legacy clients keep the original two call sites.
function guardUnfulfilledPriceQuote(reply,language="zh",{validateMediaPromise=false}={}){
  if(!validateMediaPromise)return checkUnfulfilledPriceQuote(reply,language);
  const {guardUnconfirmedMediaPromise}=require("./unconfirmedMediaPromiseGuard");
  const media=guardUnconfirmedMediaPromise(reply,language);
  const afterMediaReply=media.changed?media.reply:reply;
  const quote=checkUnfulfilledPriceQuote(afterMediaReply,language);
  return {...quote,mediaChanged:media.changed,afterMediaReply};
}

module.exports = { hasComplimentaryPriceClaim, verifiedComplimentaryAssessmentDraft, allowsApprovedPromotionWithoutTextQuote, isSafeUnquotedReply, configuredDurationAnswer, preserveVerifiedTwoTreatmentDraft, containsApprovedPriceAmount, hasSeparateNonPriceEnquiry, staffQuoteMatchesConfiguredPrice, preserveVerifiedModelQuote, configuredOfferPrice, requestedPricePackages, verifiedPricesForService, nonPriceExplanation, clinicalPricingAcknowledgement, ensureVerifiedPriceReply, guardUnfulfilledPriceQuote };
