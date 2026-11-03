"use strict";

// Neutro-only, text-first handling for prices AFTER the First Trial.
// Do not confuse the configured First Trial media with the later-session rate.
// Media acceptance and package-pitch acceptance must be verified from messages,
// never inferred from a model flag, lead label, or queued WhatsApp image.
const messagesRepo = require("../db/messagesRepo");
const { getPricePromotionBundle } = require("../utils/activePromotion");
const { mediaVariants } = require("../utils/mediaLocalization");
const { resolveRepeatVisitPriceReply } = require("../utils/repeatVisitPriceReply");

const SUPPORTED = new Set(["3D 小颜术", "9D 逆龄抗衰"]);
const PROMO_LOOKBACK_HOURS = 168;

function textForStage(service, language = "zh", stage = "suggest_package") {
  const locale = String(language || "").toLowerCase();
  const zh = locale.startsWith("zh");
  const ms = locale.startsWith("ms");
  if (stage === "before_promo") {
    if (ms) return "Promosi First Trial untuk " + service + " adalah berbeza daripada caj sesi seterusnya 😊 Saya boleh kongsikan promosi First Trial dahulu jika anda mahu. Harga sesi susulan boleh disemak oleh staf pusat.";
    if (!zh) return "The First Trial promotion for " + service + " is separate from subsequent-session pricing 😊 I can share our First Trial offer first if you'd like. Our team can confirm the later-session rate.";
    return service + " 的 First Trial 体验优惠和第二次之后的收费是不同的哦 😊 如果你还没看过，我可以先分享目前的体验优惠；续做单次收费可以由门店同事确认。";
  }
  if (stage === "staff_handoff") {
    if (ms) return "Boleh 😊 Saya faham anda ingin tahu harga sesi susulan " + service + " secara khusus. Saya akan minta staf pusat mengesahkan harga sesi individu dan pilihan pakej untuk anda.";
    if (!zh) return "Of course 😊 I understand you're asking specifically for the subsequent-session price of " + service + ". I'll ask our team to confirm the individual-session rate and available package options with you.";
    return "明白哦 😊 你想确认的是 " + service + " 续做时的单次收费。我会请门店同事直接帮你确认单次价格，也可以一起介绍适合的配套选择。";
  }
  if (ms) return "Jika anda bercadang sambung " + service + ", anda juga boleh pertimbangkan pilihan pakej rawatan 😊 Staf pusat boleh terangkan pilihan yang sesuai selepas memahami keperluan anda. Mahu saya bantu semak?";
  if (!zh) return "If you're planning to continue with " + service + ", you could also explore a multi-session treatment package 😊 Our team can explain the available options based on your needs. Would you like me to help you check?";
  return "如果你打算继续做 " + service + "，也可以考虑了解多次护理配套哦 😊 门店同事可以根据你的需求介绍适合的选择。要我帮你了解一下吗？";
}

function packageSuggestionVariants(service) {
  return ["zh", "en", "ms"].map(language =>
    textForStage(service, language, "suggest_package")
  );
}

function staffPriceReference(service, services = []) {
  const configured = services.find(entry => entry?.name === service);
  const match = String(configured?.priceRange || "").match(/\bNormal\s+Price\s*(RM\s*[\d,]+)\b/iu);
  return match ? match[1].replace(/\s+/gu, "") : "refer to Treatment configuration";
}

function createNeutroSubsequentPricingService({
  wasMediaRecentlySent = messagesRepo.wasMediaRecentlySent,
  hasRecentAcceptedPackageSuggestion = messagesRepo.hasRecentAcceptedPackageSuggestion,
} = {}) {
  return async function resolveNeutroSubsequentPricing({
    contactId, inboundMessageId, customerText, conversationHistory = [],
    services = [], serviceAliases = [], promotions = [], language = "zh",
    now = Date.now(),
  } = {}) {
    const classification = resolveRepeatVisitPriceReply({
      customerText, conversationHistory, services, serviceAliases, language, now,
    });
    const service = classification?.treatment;
    if (!SUPPORTED.has(service) || !Number.isSafeInteger(Number(contactId)) ||
        !Number.isSafeInteger(Number(inboundMessageId))) return null;

    // Only current, independently configured FIRST TRIAL campaign images
    // qualify. In particular, a combined 3D+9D graphic is not evidence for
    // an individual treatment's repeat-session conversation.
    const bundle = getPricePromotionBundle(promotions, service, null, new Date(now));
    const images = [...new Set((bundle?.packages || [])
      .flatMap(option => mediaVariants(option).map(variant => variant.imageUrl))
      .filter(Boolean))];
    let promoAccepted = false;
    for (const imageUrl of images) {
      if (await wasMediaRecentlySent(contactId, imageUrl, PROMO_LOOKBACK_HOURS)) {
        promoAccepted = true;
        break;
      }
    }

    if (!promoAccepted) return {
      treatment: service, mode: "before_promo",
      reply: textForStage(service, language, "before_promo"),
    };

    const alreadySuggested = await hasRecentAcceptedPackageSuggestion(
      contactId, packageSuggestionVariants(service), inboundMessageId
    );
    if (!alreadySuggested) return {
      treatment: service, mode: "suggest_package",
      reply: textForStage(service, language, "suggest_package"),
    };

    return {
      treatment: service, mode: "staff_handoff",
      reply: textForStage(service, language, "staff_handoff"),
      staffReason: "Repeat-session price requested after package suggestion: " +
        service + " (configured normal rate: " +
        staffPriceReference(service, services) + "). Staff to confirm individual " +
        "and package options.",
    };
  };
}

module.exports = {
  createNeutroSubsequentPricingService,
  resolveNeutroSubsequentPricing: createNeutroSubsequentPricingService(),
  textForStage,
  packageSuggestionVariants,
  staffPriceReference,
};
