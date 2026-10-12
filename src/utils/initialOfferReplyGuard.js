"use strict";

const {
  hasCustomerPriceEnquiry,
  hasExplicitPriceRequest,
  hasCustomerServiceEnquiry,
} = require("./customerEnquiryEvidence");

// A final outbound boundary for a first WhatsApp message without a current
// price enquiry. Consent detection must not control unsolicited price safety.
// Replace commercial model output with deterministic conversational copy.
// Bare numbers may be phone numbers, address units or durations, not prices.
// Merely describing Package A and Package B is not a price or promotion.
const COMMERCIAL_REPLY_CONTENT =
  /(?:\b(?:rm|myr)(?=\d|\s|[^\p{L}\p{N}]|$)|\b(?:ringgit|pricing|prices?|costs?|fees?|charges?|promos?|promotions?|discounts?|deals?|vouchers?|coupons?|offers?|sales?|harga|promosi|tawaran|diskaun|percuma|gifts?|bonuses?|rebates?|cashbacks?)\b|\b(?:free|complimentary)\b.{0,50}\b(?:massage|gift|session|treatment|trial|consultation|add[-\s]?on|bonus)\b|(?:first[\s-]*trial|trial[\s-]*price)|令吉|[价價][钱錢格位]|优惠|優惠|促销|促銷|折扣|限时|限時|特价|特價|赠|贈|礼遇|禮遇|免费|免費|原价|原價|现价|現價|只需|仅需|僅需|\d{1,3}\s*%\s*(?:off|discount)?|(?:\d\uFE0F?\u20E3){2,})/iu;

const DURATION_REQUEST =
  /(?:多久|多长|多長|几分钟|幾分鐘|几小时|幾小時|\bhow\s+long\b|\bduration\b|\bberapa\s+lama\b)/iu;

// A standalone bare amount, or a plausible treatment/offer amount, must still
// be guarded when Gemini writes "骨盆 388 / 288" without an RM prefix.
// Avoid interpreting phone numbers, address codes, years, session counts and
// clinical durations as sales amounts.
const BARE_AMOUNT = /(?<![A-Za-z0-9])[1-9]\d{2,4}(?![A-Za-z0-9])/gu;
const BARE_PRICE_CONTEXT = /(?:骨盆|小颜|小顏|逆龄|逆齡|护理|護理|疗程|療程|调理|調理|价|價|套餐|配套|体验|體驗|首单|首單|仅|僅|只要|现在|現在|起|每次|\b(?:3d|9d|pelvic|treatment|package|trial|offer|promo|only|just|from|starting|cost|price|for|per\s+session|harga|pakej|rawatan)\b)/iu;
const CONTACT_OR_ADDRESS_CONTEXT = /(?:电话|電話|联络|聯絡|联系|聯繫|号码|號碼|地址|邮编|郵編|楼|樓|门牌|門牌|\b(?:call|phone|contact|tel|whatsapp|address|postcode|unit|suite|block|nombor|telefon|alamat)\b)/iu;
const NON_PRICE_NUMBER_SUFFIX = /^\s*(?:\+\s*(?:体态案例|體態案例|案例|顾客|顧客|客户|客戶|患者|个|個|人|位|例|\b(?:cases?|clients?|customers?|patients?)\b)|年|月|日|人|位|个|個|次|分钟|分鐘|小时|小時|岁|歲|例|名|天|周|週|星期|%|\b(?:years?|months?|days?|hours?|minutes?|mins?|people|times|sessions?|cases?|patients?|weeks?|percent)\b)/iu;

function hasBarePriceContent(value) {
  const content = String(value || "").normalize("NFKC");
  for (const clause of content.split(/[，,。.!！?？;；\n]+/u)) {
    const ranges = [...clause.matchAll(/(?:\+?\d[\d\s()-]{7,}\d)/gu)]
      .filter((match) => match[0].replace(/\D/gu, "").length >= 8)
      .map((match) => [match.index, match.index + match[0].length]);
    const candidates = [...clause.matchAll(BARE_AMOUNT)].filter((match) => {
      const value = match[0], index = match.index;
      if (/^(?:19|20)\d{2}$/u.test(value)) return false;
      if (ranges.some(([start, end]) => index >= start && index + value.length <= end)) return false;
      const prefix = clause.slice(Math.max(0, index - 48), index);
      // An earlier address/phone label only exempts numbers belonging to that
      // field. If a treatment or price phrase appears AFTER that label, a
      // separate amount must still be treated as a possible unsolicited price.
      const adminTerms = [...prefix.matchAll(
        new RegExp(CONTACT_OR_ADDRESS_CONTEXT.source, "giu")
      )];
      const lastAdmin = adminTerms[adminTerms.length - 1];
      if (lastAdmin) {
        const afterAdmin = prefix.slice(lastAdmin.index + lastAdmin[0].length);
        if (!BARE_PRICE_CONTEXT.test(afterAdmin)) return false;
      }
      if (NON_PRICE_NUMBER_SUFFIX.test(clause.slice(index + value.length))) return false;
      return true;
    });
    if (!candidates.length) continue;
    const bareOnly = /^\s*[1-9]\d{2,4}\s*$/u.test(clause);
    const multipleAmounts = candidates.length >= 2 &&
      /(?:\/|和|或|及|\bor\b|\band\b)/iu.test(clause);
    if (bareOnly || multipleAmounts || BARE_PRICE_CONTEXT.test(clause)) return true;
  }
  return false;
}

function hasCommercialReplyContent(value) {
  const normalized = String(value || "").normalize("NFKC");
  return COMMERCIAL_REPLY_CONTENT.test(normalized) || hasBarePriceContent(normalized);
}

// Match configured service names/aliases against their actual text spans.
// Removing punctuation first would make "3D、9D" look identical to the
// configured "3D+9D" combination and could mistakenly prioritize a combo.
function safeServiceFromCustomer(customerText, services, serviceAliases = []) {
  const source = String(customerText || "").normalize("NFKC").toLowerCase();
  const normalizeKey = (value) => String(value || "").normalize("NFKC")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const byName = new Map();
  for (const service of Array.isArray(services) ? services : []) {
    const key = normalizeKey(service?.name);
    if (key.length >= 2) byName.set(key, service);
  }
  const mentions = new Map();
  const negated = (start, end) => {
    const preceding = source.slice(Math.max(0, start - 32), start);
    const following = source.slice(end, end + 28);
    return /(?:不要|不是|不想(?:做|了解)?|不考虑|不考慮|不需要|不选|不選|不喜欢|不喜歡|拒绝|拒絕|don't\s+want|do\s+not\s+want|not\s+interested\s+in|tak\s+nak|tidak\s+mahu)\s*$/iu.test(preceding) ||
      /^(?:\s*(?:护理|療程|疗程|treatment|rawatan)\s*)?(?:没兴趣|沒興趣|不要|不想做|不考虑|不考慮|不需要)/iu.test(following);
  };
  const addMentions = (service, rawTerm) => {
    const term = String(rawTerm || "").normalize("NFKC").toLowerCase().trim();
    if (normalizeKey(term).length < 2) return;
    // Preserve "+", word boundaries and contiguous canonical names.
    // Whitespace in configured names may vary in customer messages.
    const parts = [];
    for (const char of term) {
      if (/\s/u.test(char)) parts.push("\\s*");
      else if (char === "+") parts.push("\\s*\\+\\s*");
      else parts.push(char.replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&"));
    }
    const asciiStart = /^[a-z0-9]/u.test(term);
    const asciiEnd = /[a-z0-9]$/u.test(term);
    const prefix = asciiStart ? "(^|[^a-z0-9])" : "";
    const suffix = asciiEnd ? "(?=$|[^a-z0-9])" : "";
    const pattern = new RegExp(prefix + parts.join("") + suffix, "giu");
    for (const match of source.matchAll(pattern)) {
      const start = match.index + (asciiStart ? match[1].length : 0);
      const end = match.index + match[0].length;
      if (negated(start, end)) continue;
      const key = normalizeKey(service.name);
      if (!mentions.has(key)) mentions.set(key, { service, spans: [] });
      mentions.get(key).spans.push({ start, end });
    }
  };

  for (const service of byName.values()) addMentions(service, service.name);
  for (const alias of Array.isArray(serviceAliases) ? serviceAliases : []) {
    const canonical = byName.get(normalizeKey(alias?.officialService));
    if (!canonical) continue;
    for (const term of String(alias?.alias || "").split(/[,|;，、]+/u)) {
      addMentions(canonical, term);
    }
  }
  const entries = [...mentions.values()];
  if (!entries.length) return null;

  const combos = entries.filter(({ service }) =>
    /[+＋&]|组合|組合|\b(?:combo|combination)\b/iu.test(service.name)
  );
  if (combos.length === 1) {
    // "3D+9D" can match both constituent aliases as well as the combo;
    // choose the combo only if every constituent mention is inside a full
    // combo mention. A separate pelvic or 3D/9D request is ambiguous.
    const combination = combos[0];
    const extra = entries.filter((entry) => entry !== combination).some((entry) =>
      entry.spans.some((span) => !combination.spans.some((whole) =>
        whole.start <= span.start && whole.end >= span.end
      ))
    );
    if (!extra && !hasCommercialReplyContent(combination.service.name)) {
      return combination.service;
    }
    return null;
  }
  if (combos.length > 1 || entries.length !== 1) return null;
  return hasCommercialReplyContent(entries[0].service.name) ? null : entries[0].service;
}

function safeIntroReply({ customerText, language, services, serviceAliases = [] }) {
  const service = safeServiceFromCustomer(customerText, services, serviceAliases);
  const name = String(service?.name || "").trim();
  const duration = String(service?.duration || "").trim();
  const includeDuration = name && DURATION_REQUEST.test(customerText) &&
    duration && duration.length <= 100 &&
    !hasCommercialReplyContent(duration);
  const locale = String(language || "").toLowerCase();
  const chinese = locale.startsWith("zh") ||
    (!locale && /[\u3400-\u9fff]/u.test(customerText));
  const malay = locale.startsWith("ms");

  if (chinese) {
    if (includeDuration) {
      return "Hi～" + name + "的护理时间通常是" + duration + " 😊\n你比较想了解护理过程，还是想先看看适不适合自己呢？";
    }
    return name
      ? "Hi～欢迎了解" + name + " 😊\n我可以先跟你介绍护理方式。你目前最想了解或改善哪一方面呢？"
      : "Hi～欢迎咨询 😊\n你目前最想了解哪一种护理，或想改善哪方面呢？";
  }
  if (malay) {
    if (includeDuration) {
      return "Hai! Tempoh rawatan " + name + " biasanya " + duration + " 😊\nApa lagi yang anda ingin tahu tentang proses rawatan?";
    }
    return name
      ? "Hai! Boleh saya terangkan lebih lanjut tentang " + name + " 😊\nBahagian mana yang anda paling ingin tahu atau perbaiki?"
      : "Hai! Terima kasih kerana menghubungi kami 😊\nRawatan atau masalah yang mana anda ingin tahu lebih lanjut?";
  }
  if (includeDuration) {
    return "Hi! " + name + " usually takes " + duration + " 😊\nWould you like to know more about how the treatment works?";
  }
  return name
    ? "Hi! Happy to share more about " + name + " 😊\nWhat would you most like to know or improve?"
    : "Hi! Thanks for getting in touch 😊\nWhich treatment would you like to know more about?";
}

/**
 * Validate the FULL assembled reply (including the configured business intro)
 * before durable message reservation or provider send.
 * Preserve escalation, AI flags, result images and existing duplicate guards.
 */
function guardFutureOfferIntroductionReply({
  channel,
  isFirstMessage,
  customerText,
  reply,
  flagged = false,
  language = "en",
  services = [],
  serviceAliases = [],
} = {}) {
  const original = String(reply || "");
  if (String(channel || "").toLowerCase() !== "whatsapp" ||
      isFirstMessage !== true || flagged === true ||
      hasCustomerPriceEnquiry(customerText) ||
      !hasCommercialReplyContent(original)) {
    return { reply: original, replaced: false };
  }
  const safe = safeIntroReply({ customerText, language, services, serviceAliases });
  // Even misconfigured service names and durations must never bypass the gate.
  if (hasCommercialReplyContent(safe)) {
    return {
      reply: "Hi! Thanks for getting in touch 😊 What would you most like to know about the treatment?",
      replaced: true,
    };
  }
  return { reply: safe, replaced: true };
}

// This guard runs after the full customer-facing text is assembled. It is
// scoped by the caller to assessment-first clients, on any channel or turn.
function hasTreatmentPriceContent(reply) {
  const original = String(reply || "").normalize("NFKC");
  const withoutVoucher = original
    .replace(/\b(?:RM|MYR)\s*100(?=\s*(?:voucher|coupon|discount|off|baucar|优惠券|優惠券|折扣券|抵用券))/giu, "[VOUCHER]")
    .replace(/(?:voucher|coupon|baucar|优惠券|優惠券|抵用券|折扣券)\s*(?:worth\s*)?(?:RM|MYR)\s*100\b/giu, "[VOUCHER]")
    .replace(/\b(?:RM|MYR)\s*100(?=\s*(?:的)?\s*(?:骨盆(?:调理|調理))?\s*(?:疗程|療程)?\s*(?:优惠券|優惠券|抵用券))/giu, "[VOUCHER]");
  return /\b(?:RM|MYR)\s*(?:[0-9]|[0-9]️⃣)|(?:[0-9]️⃣){2,}|(?:原价|原價|现价|現價|只需|仅需|僅需|价格是|價錢是|(?:price|cost)\s*(?:is|:)|harga\s*(?:ialah|:))/iu.test(withoutVoucher) ||
    hasBarePriceContent(withoutVoucher);
}

function assessmentFirstInvitation({ treatment, customerText, language = "en", services = [], serviceAliases = [] } = {}) {
  // Require a single verified service. General body/posture vocabulary is not
  // proof of pelvic-treatment interest or eligibility for a pelvic voucher.
  const matched = safeServiceFromCustomer(customerText, services, serviceAliases);
  const canonical = (Array.isArray(services) ? services : [])
    .find(service => String(service?.name || "").trim() === String(treatment || "").trim());
  const service = canonical || matched;
  const isPelvis = String(service?.name || "").trim() === "骨盆调理";
  const name = String(service?.name || "").trim();
  const locale = String(language || "").toLowerCase();
  const zh = locale.startsWith("zh") || (!locale && /[\u3400-\u9fff]/u.test(customerText));
  const ms = locale.startsWith("ms");
  if (isPelvis) {
    return zh
      ? "可以先让中医师帮你做一个1对1的体态评估 + 体验，了解实际情况后再决定适合的调理方式 😊\n到店完成评估 + 体验，还可以领取 RM100 骨盆调理疗程优惠券，具体使用条件可由门店确认。你比较方便平日还是周末来呢？"
      : ms
        ? "Anda boleh datang dahulu untuk penilaian postur 1-ke-1 + sesi percubaan bersama pengamal TCM 😊 Selepas hadir, anda boleh menerima baucar RM100 untuk rawatan pelvis. Syarat penggunaan akan disahkan oleh pusat. Hari biasa atau hujung minggu lebih sesuai?"
        : "You can start with a 1-on-1 posture assessment + trial with our TCM practitioner 😊 After attending, you can receive an RM100 pelvic-treatment voucher. Our centre can confirm the redemption conditions. Would a weekday or weekend suit you?";
  }
  if (name) {
    return zh
      ? "可以先让中医师帮你做一个1对1的评估 + 体验，根据你的情况再了解适合的" + name + "护理 😊 你比较方便平日还是周末呢？"
      : ms
        ? "Boleh mulakan dengan penilaian 1-ke-1 + sesi percubaan untuk " + name + " dahulu 😊 Hari biasa atau hujung minggu lebih sesuai?"
        : "You can start with a 1-on-1 assessment + trial for " + name + " 😊 Would a weekday or weekend be more convenient?";
  }
  return safeIntroReply({ customerText, language, services, serviceAliases });
}

function ensureFirstAssessmentInvitation({
  isFirstMessage = false, customerText, reply, flagged = false,
  language = "en", treatment = null, serviceQuery = false,
  verifiedAdService = null, services = [], serviceAliases = [],
} = {}) {
  const original = String(reply || "").trim();
  if (!isFirstMessage || flagged || !serviceQuery || !original ||
      hasExplicitPriceRequest(customerText, { treatment }) ||
      !hasCustomerServiceEnquiry(customerText) ||
      /(?:1\s*[对對]\s*1|1\s*[-–]?\s*on\s*[-–]?\s*1|one\s*[-–]?\s*on\s*[-–]?\s*one|penilaian\s*(?:postur)?|体态评估|體態評估|面部评估|面部評估)/iu.test(original)) {
    return { reply: original, appended: false };
  }
  const verified = safeServiceFromCustomer(customerText, services, serviceAliases);
  const verifiedCreative = (Array.isArray(services) ? services : []).find(
    item => item?.name === verifiedAdService && item?.name === treatment
  );
  const service = verified || verifiedCreative;
  if (!service) return { reply: original, appended: false };
  // Do not promise an automatic voucher, an extra RM100 reduction or a free
  // trial. Voucher copy is intentionally governed separately from invitation.
  const lang = String(language || "").toLowerCase();
  const chinese = lang.startsWith("zh") || (!lang && /[\u3400-\u9fff]/u.test(customerText));
  const malay = lang.startsWith("ms");
  const invitation = service.name === "骨盆调理"
    ? assessmentFirstInvitation({ treatment: service.name, customerText, language, services, serviceAliases })
    : chinese
    ? "你也可以先来让中医师做一个1对1的评估 + 体验，再了解适合自己的调理方式 😊 你比较方便平日还是周末？"
    : malay
      ? "Anda juga boleh datang untuk penilaian 1-ke-1 + sesi percubaan bersama pengamal TCM 😊 Hari biasa atau hujung minggu lebih sesuai?"
      : "You can also begin with a 1-on-1 assessment + trial with our TCM practitioner 😊 Would a weekday or weekend suit you?";
  return { reply: original + "\n\n" + invitation, appended: true };
}

function stripUnsolicitedTreatmentPrice(reply) {
  const source = String(reply || "").trim();
  // Preserve complete, useful non-price sentences instead of throwing away
  // the whole reply. Never preserve a sentence containing a suspicious amount.
  const segments = source.split(/(?<=[。！？!?;\n])|(?<=\.)\s+(?=[A-Z])/u);
  const retained = segments.filter(segment => !hasTreatmentPriceContent(segment))
    .join("").trim();
  return retained && !hasTreatmentPriceContent(retained) ? retained : "";
}

function guardAssessmentFirstPricingReply({
  customerText, reply, flagged = false, language = "en",
  services = [], serviceAliases = [], treatment = null,
} = {}) {
  const original = String(reply || "");
  if (flagged || hasExplicitPriceRequest(customerText, { treatment }) ||
      !hasTreatmentPriceContent(original)) return { reply: original, replaced: false };
  const retained = stripUnsolicitedTreatmentPrice(original);
  const fallback = assessmentFirstInvitation({ treatment, customerText, language, services, serviceAliases });
  return { reply: retained || fallback, replaced: true };
}
module.exports = {
  guardAssessmentFirstPricingReply,
  ensureFirstAssessmentInvitation,
  safeServiceFromCustomer,
  assessmentFirstInvitation,
  stripUnsolicitedTreatmentPrice,
  hasTreatmentPriceContent,
  guardFutureOfferIntroductionReply,
  hasCommercialReplyContent,
  safeIntroReply,
};
