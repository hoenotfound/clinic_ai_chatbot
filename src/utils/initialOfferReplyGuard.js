"use strict";

const {
  hasCustomerPriceEnquiry,
} = require("./customerEnquiryEvidence");

// A final outbound boundary for a first WhatsApp message without a current
// price enquiry. Consent detection must not control unsolicited price safety.
// Replace commercial model output with deterministic conversational copy.
// Bare numbers may be phone numbers, address units or durations, not prices.
const COMMERCIAL_REPLY_CONTENT =
  /(?:\b(?:rm|myr)(?=\d|\s|[^\p{L}\p{N}]|$)|\b(?:ringgit|pricing|prices?|costs?|fees?|charges?|packages?|promos?|promotions?|discounts?|deals?|vouchers?|coupons?|offers?|sales?|harga|pakej|promosi|tawaran|diskaun|percuma|gifts?|bonuses?|rebates?|cashbacks?)\b|\b(?:free|complimentary)\b.{0,50}\b(?:massage|gift|session|treatment|trial|consultation|add[-\s]?on|bonus)\b|(?:first[\s-]*trial|trial[\s-]*price)|[价價][钱錢格位]|优惠|優惠|促销|促銷|配套|套餐|折扣|限时|限時|特价|特價|赠|贈|礼遇|禮遇|免费|免費|原价|原價|现价|現價|只需|仅需|僅需|\d{1,3}\s*%\s*(?:off|discount)?|(?:\d\uFE0F?\u20E3){2,})/iu;

const DURATION_REQUEST =
  /(?:多久|多长|多長|几分钟|幾分鐘|几小时|幾小時|\bhow\s+long\b|\bduration\b|\bberapa\s+lama\b)/iu;

function hasCommercialReplyContent(value) {
  return COMMERCIAL_REPLY_CONTENT.test(String(value || "").normalize("NFKC"));
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

module.exports = {
  guardFutureOfferIntroductionReply,
  hasCommercialReplyContent,
  safeIntroReply,
};
