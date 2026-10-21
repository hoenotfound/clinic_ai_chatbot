"use strict";

const { getActivePromotions, promotionPackages, findAmbiguousPromotionPackageTerm, findMentionedPromotionPackages } = require("./activePromotion");
const { hasExplicitPriceRequest, isStandalonePriceQuestion } = require("./customerEnquiryEvidence");
const { isContextualPriceReference, resolveContinuedTreatmentPriceService, resolveRecentFirstTreatmentPriceService } = require("./priceFollowUpContext");
const { hasTreatmentPriceContent, hasCommercialReplyContent } = require("./initialOfferReplyGuard");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");
const clinicConfig = require("../config/clinicConfig");
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
  /(?:[几幾多]\s*(?:次|回|个疗程|個療程)|多少\s*(?:次|个疗程|個療程)|(?:要|需要)\s*做\s*(?:几|幾|多少)\s*次|多久|多长|多長|\bhow\s+many\s+sessions?\b|\bhow\s+long\b|\bberapa\s+(?:kali|sesi|lama)\b)/iu;

function safeNonPriceExplanation(customerText, original, language) {
  const recovery = recoveryPeriodGuidance(customerText, language);
  if (recovery) return recovery;
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
  allowContinuedPriceContext = false,
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
    return { reply: complimentaryAssessmentFeeReply(language), restored: true };
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
    if (!priceRequested && !mediaPromise && !unsolicitedAmount) {
      return { reply: original, restored: false };
    }
    const safeText = safeNonPriceExplanation(customerText, original, language);
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
    return { reply: [safeText, question].filter(Boolean).join("\n\n"), restored: true };
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
      return { reply: [text, recovery].filter(Boolean).join("\n\n"), restored: true };
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
        ? " Harga selepas baucar tertakluk pada kelayakan dan pengesahan pusat."
        : locale.startsWith("en")
          ? " The after-voucher price is subject to eligibility and confirmation by the centre."
          : " 使用优惠券需符合领取及使用条件，请以门店确认为准。"
      : "";
    const answer = locale.startsWith("ms")
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
      ? `Harga ${voucherNames} adalah selepas baucar. Kelayakan dan ketersediaan baucar tertakluk kepada pengesahan pusat; tiada diskaun tambahan dijanjikan.`
      : locale.startsWith("en")
        ? `The ${voucherNames} price is after applying the voucher, subject to eligibility and availability. Our centre can confirm the voucher terms; additional discounts are not guaranteed.`
        : `${voucherNames} 的上述价格为使用优惠券后的价格，须符合领取及使用条件；优惠券是否还有名额及能否叠加其他优惠，请以门店确认为准。`)
    : "";
  const quote = locale.startsWith("ms")
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
    Boolean(recoveryGuidance);
  const explanation = recoveryGuidance ||
    (hasClinicalMediaRisk(customerText) ||
      ((priceOnlyResponse === true ||
        (aiLed && pricingDecision.source === "meta_ad")) && !independentServiceQuestion)
      ? "" : safeNonPriceExplanation(customerText, original, language));
  const bothQuestion = aiLed && pricingDecision.source === "customer_concern_both"
    ? (locale.startsWith("ms")
      ? "Saya boleh sahkan harga rawatan ini dahulu. Bila sebut kedua-dua, adakah anda maksudkan dua rawatan berbeza atau dua bahagian yang ingin diperbaiki?"
      : locale.startsWith("en")
        ? "I can confirm this treatment's price first. By both, did you mean two different treatments or two concerns within this treatment?"
        : "先给你这项疗程的核实价格 😊 你说的两项是指两种不同疗程，还是想改善的两个部位呢？")
    : "";
  const acknowledgement = clinicalPricingAcknowledgement(customerText, language);
  return { reply: [explanation, quote, bothQuestion, acknowledgement].filter(Boolean).join("\n\n"), restored: true };
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

// hasTreatmentPriceContent() also detects price-HEADING words such as
// "价格是" without any number. This guard must instead require a visible
// numeric monetary amount to mark the heading fulfilled.
const VISIBLE_MONETARY_AMOUNT =
  /\b(?:RM|MYR)\s*[1-9]\d{1,5}(?:\.\d{2})?\b|(?:[价價](?:格|钱|錢)|收费|收費|费用|費用|harga|prices?|cost|fee)\s*(?:是|为|為|is|are)?\s*[:：]?\s*[1-9]\d{2,5}(?!\d)/iu;


function guardUnfulfilledPriceQuote(reply, language = "zh") {
  const original = String(reply || "").trim();
  if (!(UNFULFILLED_PRICE_HEADING.test(original) ||
        DIRECT_EMPTY_PRICE_HEADING.test(original)) ||
      VISIBLE_MONETARY_AMOUNT.test(original)) return { reply: original, changed: false };
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

module.exports = { configuredOfferPrice, requestedPricePackages, verifiedPricesForService, nonPriceExplanation, clinicalPricingAcknowledgement, ensureVerifiedPriceReply, guardUnfulfilledPriceQuote };
