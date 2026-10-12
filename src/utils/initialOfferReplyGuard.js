"use strict";

const {
  hasCustomerPriceEnquiry,
  hasFuturePromotionPermissionWithoutPrice,
} = require("./customerEnquiryEvidence");

// A final text boundary for a first WhatsApp introduction that grants FUTURE
// offer notifications. A model prompt alone cannot prevent unsolicited prices.
// Replace commercial model output with deterministic conversational copy.
const COMMERCIAL_REPLY_CONTENT =
  /(?:\b(?:rm|myr|ringgit|pricing|prices?|costs?|fees?|charges?|packages?|promos?|promotions?|discounts?|deals?|vouchers?|coupons?|offers?|sales?|harga|pakej|promosi|tawaran|diskaun|percuma)\b|(?:first[\s-]*trial|trial[\s-]*price|free[\s-]*(?:gift|massage|session|treatment))|[价價][钱錢格位]|优惠|優惠|促销|促銷|配套|套餐|折扣|限时|限時|特价|特價|赠|贈|礼遇|禮遇|免费|免費|原价|原價|现价|現價|只需|仅需|僅需|\b\d{1,3}\s*%\s*(?:off|discount)?\b|(?:^|[^\d])\d{3,5}(?:[^\d]|$))/iu;

const DURATION_REQUEST =
  /(?:多久|多长|多長|几分钟|幾分鐘|几小时|幾小時|\bhow\s+long\b|\bduration\b|\bberapa\s+lama\b)/iu;

function hasCommercialReplyContent(value) {
  return COMMERCIAL_REPLY_CONTENT.test(String(value || "").normalize("NFKC"));
}

function safeServiceFromCustomer(customerText, services) {
  const normalize = (text) => String(text || "")
    .normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const input = normalize(customerText);
  const matched = (Array.isArray(services) ? services : []).filter((service) => {
    const name = String(service?.name || "").trim();
    return name && normalize(name).length >= 3 && input.includes(normalize(name));
  });
  if (matched.length !== 1 || hasCommercialReplyContent(matched[0].name)) return null;
  return matched[0];
}

function safeIntroReply({ customerText, language, services }) {
  const service = safeServiceFromCustomer(customerText, services);
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
} = {}) {
  const original = String(reply || "");
  if (String(channel || "").toLowerCase() !== "whatsapp" ||
      isFirstMessage !== true || flagged === true ||
      !hasFuturePromotionPermissionWithoutPrice(customerText) ||
      hasCustomerPriceEnquiry(customerText) ||
      !hasCommercialReplyContent(original)) {
    return { reply: original, replaced: false };
  }
  const safe = safeIntroReply({ customerText, language, services });
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
