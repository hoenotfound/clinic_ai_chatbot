"use strict";

// Neutro-only, text-first handling for prices AFTER the First Trial.
// Do not confuse the configured First Trial media with the later-session rate.
// Media acceptance and package-pitch acceptance must be verified from messages,
// never inferred from a model flag, lead label, or queued WhatsApp image.
const messagesRepo = require("../db/messagesRepo");
const { getPricePromotionBundle } = require("../utils/activePromotion");
const { mediaVariants, resolveLocalizedMedia } = require("../utils/mediaLocalization");
const { configuredPromotionCopyBlocked } = require("../utils/promotionClinicalCopyPolicy");
const { resolveRepeatVisitPriceReply } = require("../utils/repeatVisitPriceReply");
const { hasExplicitPriceRequest } = require("../utils/customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("../utils/aiReviewPolicy");
const { findServicesInText, serviceCandidates } = require("../utils/conversationPromptContext");

const SUPPORTED = new Set(["3D 小颜术", "9D 逆龄抗衰"]);
const PROMO_LOOKBACK_HOURS = 168;

function textForStage(service, language = "zh", stage = "suggest_package") {
  const locale = String(language || "").toLowerCase();
  const zh = locale.startsWith("zh");
  const ms = locale.startsWith("ms");
  if (stage === "before_promo") {
    if (ms) return "Harga First Trial untuk " + service + " berbeza daripada caj sesi seterusnya 😊 Promosi First Trial boleh dijadikan rujukan, tetapi staf pusat perlu mengesahkan harga sesi susulan.";
    if (!zh) return "The First Trial promotion for " + service + " is separate from subsequent-session pricing 😊 The First Trial offer is a reference only; our team can confirm the later-session rate.";
    return service + " 的 First Trial 体验优惠和第二次之后的收费是不同的哦 😊 体验优惠只能作为参考，续做单次收费可以由门店同事确认。";
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

// After an ACCEPTED package pitch, "But how much?" is still a request for
// the later-session rate. Do not require the customer to repeat "second".
// A new named treatment price enquiry or a package-price enquiry is NOT this
// continuation, and must retain the ordinary promotion rules.
function isPersistentIndividualPriceQuestion(customerText, services, serviceAliases) {
  const text = String(customerText || "").trim();
  if (!text || text.length > 180 ||
      hasClinicalMediaRisk(text) || !hasExplicitPriceRequest(text)) return false;
  const mentions = [...new Set(findServicesInText(
    text, serviceCandidates(services, serviceAliases)
  ))];
  if (mentions.length > 1) return false;
  const explicitIndividual = /(?:第二次|第2次|续做|續做|后续|後續|之后|之後|正常价|正常價|原价|原價|单次|單次|每次|\b(?:second|next|subsequent|repeat|regular|normal|individual|per[\s-]?session)\b|\b(?:sesi|rawatan)\s+(?:kedua|seterusnya)\b)/iu.test(text);
  const trialOnly = /(?:first[\s-]*trial|首次体验|首次體驗|体验价|體驗價|优惠价|優惠價|\b(?:promotion|promo|offer)\b)/iu.test(text)
    && !explicitIndividual;
  const packageRequest = /(?:配套|套餐|\b(?:packages?|pakej)\b)/iu.test(text);
  const packageRefusal = /(?:不要|不需要|不想|不用|只想|不考虑|不考慮|don't|do not|not interested|just want|only want)/iu.test(text);
  if (trialOnly || (packageRequest && !packageRefusal && !explicitIndividual)) return false;
  // If the new question names a treatment, require a clear regular-session
  // marker; otherwise "3D多少钱" remains eligible for the First Trial graphic.
  if (mentions.length && !explicitIndividual) return false;
  return true;
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
      allowDirectNamedService: true,
    });
    if (!Number.isSafeInteger(Number(contactId)) ||
        !Number.isSafeInteger(Number(inboundMessageId))) return null;
    let service = classification?.treatment;
    let priorSuggested = false;

    // A customer may reply "But how much?" after the package invitation.
    // Recover the treatment from the exact accepted invitation, NOT an ad,
    // lead label, or model guess. Keep the match sender/contact scoped.
    if (!SUPPORTED.has(service) &&
        isPersistentIndividualPriceQuestion(customerText, services, serviceAliases)) {
      const named = [...new Set(findServicesInText(
        customerText, serviceCandidates(services, serviceAliases)
      ))];
      const candidates = [...SUPPORTED].filter(name =>
        named.length === 0 || (named.length === 1 && named[0] === name)
      );
      const matches = [];
      for (const name of candidates) {
        if (await hasRecentAcceptedPackageSuggestion(
          contactId, packageSuggestionVariants(name), inboundMessageId
        )) matches.push(name);
      }
      if (matches.length === 1) {
        service = matches[0];
        priorSuggested = true;
      }
    }
    if (!SUPPORTED.has(service)) return null;

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

    const alreadySuggested = priorSuggested ||
      await hasRecentAcceptedPackageSuggestion(
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

// Only the pre-promo stage can select a First Trial image for a later-session
// enquiry. server.js reuses the normal queued/direct sender and its live guards.
async function resolveNeutroFirstTrialPromotion({
  contactId, treatment, language = "zh", promotions = [],
  trustAdminConfiguredContent = false, now = Date.now(),
  wasMediaRecentlySent = messagesRepo.wasMediaRecentlySent,
  hasUnconfirmedMediaDelivery = messagesRepo.hasUnconfirmedMediaDelivery,
} = {}) {
  if (!Number.isSafeInteger(Number(contactId)) || Number(contactId) <= 0 ||
      !SUPPORTED.has(treatment)) return null;
  const bundle = getPricePromotionBundle(promotions, treatment, null, new Date(now));
  // A multi-package campaign is not one unambiguous First Trial graphic.
  if (!bundle || bundle.packages.length !== 1 ||
      configuredPromotionCopyBlocked(bundle.promotion, trustAdminConfiguredContent)) return null;
  const [option] = bundle.packages;
  if (typeof wasMediaRecentlySent !== "function" ||
      typeof hasUnconfirmedMediaDelivery !== "function") return null;
  try {
    for (const variant of mediaVariants(option)) {
      // Never repeat an accepted image or retry an unresolved attempt. Check
      // every translated URL, even if this request uses a different language.
      if (await hasUnconfirmedMediaDelivery(contactId, variant.imageUrl) ||
          await wasMediaRecentlySent(contactId, variant.imageUrl, PROMO_LOOKBACK_HOURS)) {
        return null;
      }
    }
  } catch (error) {
    console.warn("[Pricing] First Trial receipt unavailable; skipping optional image:", error);
    return null;
  }
  return { ...bundle, packages: [resolveLocalizedMedia(option, language)] };
}

module.exports = {
  createNeutroSubsequentPricingService,
  resolveNeutroSubsequentPricing: createNeutroSubsequentPricingService(),
  resolveNeutroFirstTrialPromotion,
  textForStage,
  packageSuggestionVariants,
  staffPriceReference,
  isPersistentIndividualPriceQuestion,
};
