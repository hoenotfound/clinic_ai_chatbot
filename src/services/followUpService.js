const clinicConfig = require("../config/clinicConfig");
const messagesRepo = require("../db/messagesRepo");
const followUpRepo = require("../db/followUpRepo");
const contactsRepo = require("../db/contactsRepo");
const pipelineRepo = require("../db/pipelineRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
const { detectConversationLanguage } = require("../utils/chatLanguage");
const { inferConfiguredServiceFromText } = require("../utils/serviceInterest");
const {
  getActivePromotions,
  promotionPackages,
  promotionFollowUpTexts,
  promotionHasFollowUpMessage,
  findAmbiguousPromotionPackageTerm,
  findMentionedPromotionPackages,
} = require("../utils/activePromotion");
const { randomUUID } = require("node:crypto");
const channelMessaging = require("./channelMessagingService");
const mediaStorage = require("./mediaStorageService");
const followUpAiService = require("./followUpAiService");
const followUpAiLeaseRepo = require("../db/followUpAiLeaseRepo");
const pricingReminderService = require("./pricingReminderService");
const { automatedRepliesEnabled } = require("./automaticReplyControl");
const {
  normalizeQuietHours,
  quietHoursStatus,
} = require("../utils/quietHours");

// Retained as the failure-retry delay/export. Normal operation now sleeps until
// the next actual follow-up is due instead of polling Postgres every minute.
const FOLLOW_UP_CHECK_INTERVAL_MS = 60 * 1000;
const FOLLOW_UP_BATCH_SIZE = 25;
const STALE_CLAIM_GRACE_MINUTES = 10;

let sweepRunning = false;
let followUpTimer = null;

function normalizeFollowUpTranslations(value, fallbackMessage) {
  if (value !== undefined && (typeof value !== "object" || value === null)) {
    return null;
  }
  return Object.fromEntries(
    ["en", "ms", "zh"].map((key) => [
      key,
      typeof value?.[key] === "string" && value[key].trim()
        ? value[key].trim()
        : fallbackMessage,
    ])
  );
}

function normalizeServiceOverrides(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) return null;

  const configuredServices = new Set(
    (Array.isArray(clinicConfig.services) ? clinicConfig.services : [])
      .map((service) =>
        typeof service?.name === "string"
          ? service.name.trim().toLocaleLowerCase()
          : ""
      )
      .filter(Boolean)
  );
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const serviceName =
      typeof item?.serviceName === "string" ? item.serviceName.trim() : "";
    const message = typeof item?.message === "string" ? item.message.trim() : "";
    if (!serviceName || !message || message.length > 1000) return null;

    const key = serviceName.toLocaleLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);

    // Fail safe at runtime for legacy/stale configs. A renamed or removed
    // service must fall back to the step's general message rather than keep
    // sending copy for a service that no longer exists.
    if (!configuredServices.has(key)) continue;

    const translations = normalizeFollowUpTranslations(
      item.translations,
      message
    );
    if (!translations) return null;
    const imageUrl =
      typeof item?.imageUrl === "string" ? item.imageUrl.trim() : "";
    const videoKey =
      typeof item?.videoKey === "string" ? item.videoKey.trim() : "";
    if (imageUrl && videoKey) return null;

    normalized.push({
      serviceName,
      message,
      translations,
      imageUrl,
      videoKey,
      videoFilename:
        typeof item?.videoFilename === "string"
          ? item.videoFilename.trim().slice(0, 255)
          : "",
    });
  }
  return normalized;
}

function normalizeFollowUpStep(value) {
  const timingMode =
    value?.timingMode === "before_window_expiry"
      ? "before_window_expiry"
      : "after_reply";
  const beforeWindowExpiryMinutes = Number(
    value?.beforeWindowExpiryMinutes ?? 120
  );
  const delayMinutes =
    timingMode === "before_window_expiry" &&
    Number.isInteger(beforeWindowExpiryMinutes)
      ? 24 * 60 - beforeWindowExpiryMinutes
      : Number(value?.delayMinutes);
  const message = typeof value?.message === "string" ? value.message.trim() : "";
  if (
    !Number.isInteger(delayMinutes) ||
    delayMinutes < 5 ||
    delayMinutes > 23 * 60 ||
    !Number.isInteger(beforeWindowExpiryMinutes) ||
    beforeWindowExpiryMinutes < 60 ||
    beforeWindowExpiryMinutes > 360 ||
    !message ||
    message.length > 1000 ||
    (value?.imageUrl !== undefined && typeof value.imageUrl !== "string") ||
    (value?.videoKey !== undefined && typeof value.videoKey !== "string") ||
    (value?.videoFilename !== undefined && typeof value.videoFilename !== "string") ||
    (String(value?.imageUrl || "").trim() && String(value?.videoKey || "").trim())
  ) {
    return null;
  }

  const translations = normalizeFollowUpTranslations(
    value.translations,
    message
  );
  const serviceOverrides = normalizeServiceOverrides(value.serviceOverrides);
  if (!translations || !serviceOverrides) return null;

  return {
    delayMinutes,
    timingMode,
    beforeWindowExpiryMinutes,
    messageMode: value?.messageMode === "ai" ? "ai" : "fixed",
    aiInstruction:
      typeof value?.aiInstruction === "string"
        ? value.aiInstruction.trim().slice(0, 1000)
        : "",
    message,
    translations,
    imageUrl: value.imageUrl?.trim() || "",
    videoKey: value.videoKey?.trim() || "",
    videoFilename:
      typeof value?.videoFilename === "string"
        ? value.videoFilename.trim().slice(0, 255)
        : "",
    serviceOverrides,
  };
}

function getActiveSettings() {
  if (!automatedRepliesEnabled()) return null;

  const settings = clinicConfig.automatedFollowUp;
  if (
    !settings?.enabled ||
    !["all", "staff"].includes(settings.triggerMode) ||
    typeof settings.activatedAt !== "string" ||
    Number.isNaN(Date.parse(settings.activatedAt))
  ) {
    return null;
  }

  const quietHours = normalizeQuietHours(settings.quietHours);
  if (!quietHours) return null;

  const rawAdditionalSteps =
    settings.additionalSteps === undefined ? [] : settings.additionalSteps;
  if (!Array.isArray(rawAdditionalSteps) || rawAdditionalSteps.length > 2) {
    return null;
  }

  const steps = [
    normalizeFollowUpStep(settings),
    ...rawAdditionalSteps.map(normalizeFollowUpStep),
  ];
  if (steps.some((step) => !step)) return null;

  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index].delayMinutes <= steps[index - 1].delayMinutes) {
      return null;
    }
  }

  return {
    triggerMode: settings.triggerMode,
    activatedAt: settings.activatedAt,
    quietHours,
    steps,
    pricingReminder: {
      enabled: settings.pricingReminder?.enabled === true,
      activatedAt: settings.pricingReminder?.activatedAt || null,
      requirePricingInterest: settings.pricingReminder?.requirePricingInterest !== false,
      sendBothPelvicPackages: settings.pricingReminder?.sendBothPelvicPackages === true,
    },
  };
}

function normalizedServiceName(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
    : "";
}

function serviceTerms(serviceName) {
  const normalizedTarget = normalizedServiceName(serviceName);
  const aliases = Array.isArray(clinicConfig.serviceAliases)
    ? clinicConfig.serviceAliases
        .filter(
          (item) =>
            normalizedServiceName(item?.officialService) === normalizedTarget
        )
        .map((item) => String(item?.alias || "").trim())
        .filter(Boolean)
    : [];
  return [serviceName, ...aliases]
    .map(normalizedServiceName)
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

function textContainsServiceTerm(text, term) {
  const normalizedText = normalizedServiceName(text);
  if (!normalizedText || !term) return false;

  // Short Latin service aliases such as "3D" need token boundaries so they
  // do not match inside unrelated words. Chinese/mixed-language names can use
  // a normal substring match because word boundaries are not reliable there.
  if (/^[a-z0-9][a-z0-9 .+\-_/]{0,3}$/i.test(term)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`, "i")
      .test(normalizedText);
  }
  return normalizedText.includes(term);
}

function configuredServicesMentionedInText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return [];

  const matches = [];
  for (const service of Array.isArray(clinicConfig.services)
    ? clinicConfig.services
    : []) {
    const serviceName =
      typeof service?.name === "string" ? service.name.trim() : "";
    const normalized = normalizedServiceName(serviceName);
    if (!normalized) continue;

    const matchedTerms = serviceTerms(serviceName).filter((term) =>
      textContainsServiceTerm(text, term)
    );
    if (matchedTerms.length > 0) {
      matches.push({ serviceName, matchedTerms });
    }
  }

  if (matches.length <= 1) {
    return matches.map((item) => item.serviceName);
  }

  // Prefer one explicitly named combined service only when its matched phrase
  // fully contains the component-service phrases and those components do not
  // also appear separately elsewhere in the same customer message. This turns
  // "3D+9D" into the configured combination service while keeping genuine
  // comparisons such as "3D or 9D?" ambiguous.
  const normalizedText = normalizedServiceName(text);
  const covering = matches.filter((candidate) =>
    candidate.matchedTerms.some((candidateTerm) =>
      matches.every((other) => {
        if (other === candidate) return true;
        return other.matchedTerms.some(
          (otherTerm) =>
            candidateTerm.length > otherTerm.length &&
            candidateTerm.includes(otherTerm)
        );
      })
    )
  );

  if (covering.length === 1) {
    const [candidate] = covering;
    const residual = candidate.matchedTerms.reduce(
      (current, term) => current.split(term).join(" "),
      normalizedText
    );
    const hasSeparateComponent = matches.some(
      (other) =>
        other !== candidate &&
        serviceTerms(other.serviceName).some((term) =>
          textContainsServiceTerm(residual, term)
        )
    );
    if (!hasSeparateComponent) {
      return [candidate.serviceName];
    }
  }

  // Keep follow-up targeting aligned with the durable CRM/scoring resolver.
  // When the customer names both component services without an explicit combo
  // alias (for example "3D 小颜术 / 9D 逆龄抗衰"), the CRM correctly stores the
  // configured combination. The older follow-up matcher used to see two
  // services and fall back to a generic follow-up. Reuse the shared resolver
  // only when no combined service phrase was already matched above, preserving
  // the stricter residual check for text such as "3D+9D, but I want 3D".
  const hasDirectCombinedMatch = matches.some((item) =>
    normalizedServiceName(item.serviceName).includes("+")
  );
  if (!hasDirectCombinedMatch) {
    const inferredService = inferConfiguredServiceFromText(text);
    if (
      inferredService &&
      normalizedServiceName(inferredService).includes("+")
    ) {
      return [inferredService];
    }
  }

  return matches.map((item) => item.serviceName);
}

function serviceMentionFromMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const matches = configuredServicesMentionedInText(message);
    if (matches.length === 1) {
      return { serviceName: matches[0], mentioned: true };
    }
    if (matches.length > 1) {
      return { serviceName: null, mentioned: true };
    }
  }
  return { serviceName: null, mentioned: false };
}

function followUpServiceContext(candidate) {
  // The current customer exchange is authoritative. An explicit service switch
  // or comparison here must never be overridden by older history.
  const currentCustomer = serviceMentionFromMessages(
    candidate.recent_inbound_messages
  );
  if (currentCustomer.mentioned) return currentCustomer;

  // A single service in the latest outbound anchor is strong current context
  // (for example a 3D result/ad reply). A multi-service package anchor is not:
  // its included treatments should not hijack the customer's primary interest.
  const anchorMatches = configuredServicesMentionedInText(
    candidate.trigger_message_content
  );
  if (anchorMatches.length === 1) {
    return { serviceName: anchorMatches[0], mentioned: true };
  }

  // When the current customer turn is generic ("price?", "how much?") and the
  // anchor lists several package components, carry forward the most recent
  // customer-named service from the last 24 hours. This is what keeps a Pelvic
  // Care enquiry targeted even when the package caption also mentions uterus
  // care or moxibustion.
  const recentCustomer = serviceMentionFromMessages(
    candidate.recent_service_messages
  );
  if (recentCustomer.mentioned) return recentCustomer;

  if (anchorMatches.length > 1) {
    return { serviceName: null, mentioned: true };
  }

  return { serviceName: null, mentioned: false };
}

function looksLikePromotionEnquiry(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text) return false;
  return /(?:\b(?:price|pricing|cost|harga|berapa|promo|promotion|offer|discount|package|packages)\b|\brm\s*\d+|价格|價錢|价钱|多少钱|多少錢|几钱|幾錢|收费|收費|费用|費用|优惠|優惠|配套|套餐|促销|促銷)/iu.test(text);
}

function configuredServiceByName(value) {
  const target = normalizedServiceName(value);
  if (!target) return null;
  return (Array.isArray(clinicConfig.services) ? clinicConfig.services : [])
    .map((service) => typeof service?.name === "string" ? service.name.trim() : "")
    .find((serviceName) => normalizedServiceName(serviceName) === target) || null;
}

function mostSpecificConfiguredServiceInText(value) {
  const transcript = String(value || "").trim();
  if (!transcript) return { serviceName: null, mentioned: false };

  const scored = [];
  for (const service of Array.isArray(clinicConfig.services)
    ? clinicConfig.services
    : []) {
    const serviceName =
      typeof service?.name === "string" ? service.name.trim() : "";
    if (!serviceName) continue;

    const scores = serviceTerms(serviceName)
      .filter((term) => textContainsServiceTerm(transcript, term))
      .map((term) =>
        normalizedServiceName(term).replace(/[^\p{L}\p{N}]+/gu, "").length
      )
      .filter((score) => score > 0);
    if (scores.length > 0) {
      scored.push({ serviceName, score: Math.max(...scores) });
    }
  }

  if (scored.length === 0) {
    return { serviceName: null, mentioned: false };
  }

  const bestScore = Math.max(...scored.map((item) => item.score));
  const winners = scored.filter((item) => item.score === bestScore);
  return {
    serviceName: winners.length === 1 ? winners[0].serviceName : null,
    mentioned: true,
  };
}

function mostRecentConfiguredServiceInMessages(messages) {
  for (const value of Array.isArray(messages) ? messages : []) {
    const match = mostSpecificConfiguredServiceInText(value);
    if (match.mentioned) return match;
  }
  return { serviceName: null, mentioned: false };
}

function localizedPromotionFollowUp(value, language) {
  const fallback = String(value?.followUpMessage || "").trim();
  const localized = value?.followUpTranslations
    && typeof value.followUpTranslations === "object"
    && !Array.isArray(value.followUpTranslations)
    ? String(value.followUpTranslations[language] || "").trim()
    : "";
  return localized || fallback;
}

function promotionFollowUpForCandidate(candidate, language = "en") {
  const recentInbound = Array.isArray(candidate.recent_inbound_messages)
    ? candidate.recent_inbound_messages.filter(
        (value) => typeof value === "string" && value.trim()
      )
    : [];
  const latestInbound = recentInbound[0] || null;
  const latestIsPromotionEnquiry = looksLikePromotionEnquiry(latestInbound);

  const customerTranscript = recentInbound.join("\n");
  const activePromotions = getActivePromotions(clinicConfig.promotions || []);

  // Customer wording is authoritative. Walk newest -> oldest and stop at the
  // first customer message that mentions any configured service. Only when the
  // customer never named a service do we consult the outbound anchor/CRM.
  // This prevents package captions such as "子宫护理" from hijacking a current
  // "骨盆调理多少钱？" enquiry.
  const customerService = mostRecentConfiguredServiceInMessages(recentInbound);
  let serviceName = customerService.serviceName;
  if (!serviceName && customerService.mentioned) return null;

  if (!serviceName) {
    serviceName = configuredServiceByName(candidate.treatment_interest);
  }

  // The latest lead treatment interest is populated from the structured reply
  // path and is safer than parsing package/media captions. Only consult the
  // outbound anchor when neither the customer nor the current CRM state names
  // a configured service.
  if (!serviceName) {
    const outboundService = mostSpecificConfiguredServiceInText(
      candidate.trigger_message_content
    );
    serviceName = outboundService.serviceName;
    if (!serviceName && outboundService.mentioned) return null;
  }
  if (!serviceName) return null;

  const serviceKey = normalizedServiceName(serviceName);
  const matches = activePromotions.filter(
    (item) =>
      normalizedServiceName(item?.linkedService) === serviceKey &&
      promotionHasFollowUpMessage(item)
  );
  if (matches.length !== 1) return null;
  const [promotion] = matches;

  const configuredPackages = Array.isArray(promotion.packages)
    ? promotion.packages.filter((item) => item && typeof item === "object")
    : [];

  if (configuredPackages.length > 0) {
    // Advanced Config blocks ambiguous package terms, but legacy/stale runtime
    // config must still fail closed instead of guessing a package.
    if (findAmbiguousPromotionPackageTerm(promotion)) return null;

    const packages = promotionPackages(promotion);

    // The recent-price-context bridge exists only to choose between multiple
    // package offers. A single-package promotion keeps the original strict
    // behavior: the current customer message itself must be a price/promo
    // enquiry before its hidden follow-up can replace the normal step.
    if (packages.length === 1 && !latestIsPromotionEnquiry) return null;

    const mentionedByCustomer = findMentionedPromotionPackages(
      packages,
      customerTranscript
    );

    // A single explicit package mention is authoritative and does not need AI.
    // A service with only one configured package is also unambiguous.
    const deterministicPackage =
      mentionedByCustomer.length === 1
        ? mentionedByCustomer[0]
        : mentionedByCustomer.length === 0 && packages.length === 1
          ? packages[0]
          : null;

    if (deterministicPackage) {
      const message = localizedPromotionFollowUp(deterministicPackage, language);
      return message
        ? {
            message,
            targetedService: serviceName,
            promotionFollowUp: true,
            promotionPackageName: deterministicPackage.name,
            promotionFollowUpImageUrl: String(
              deterministicPackage.followUpImageUrl || ""
            ).trim(),
          }
        : null;
    }

    // Generic package enquiries and comparisons no longer send every hidden
    // discount. A small internal AI routing pass may choose exactly one package
    // from the customer's own history. If it cannot, the normal step message
    // remains the safe fallback.
    if (packages.length > 1) {
      return {
        message: null,
        targetedService: serviceName,
        promotionFollowUp: false,
        packageSelection: {
          serviceName,
          packages,
          requiresRecentPromotionEnquiry: !latestIsPromotionEnquiry,
        },
      };
    }
    return null;
  }

  if (!latestIsPromotionEnquiry) return null;

  const message = localizedPromotionFollowUp(promotion, language);
  return message
    ? {
        message,
        targetedService: serviceName,
        promotionFollowUp: true,
        promotionFollowUpImageUrl: String(
          promotion.followUpImageUrl || ""
        ).trim(),
      }
    : null;
}

function activePromotionFollowUpStillConfigured(
  serviceName,
  message,
  packageName = null,
  imageUrl = ""
) {
  const serviceKey = normalizedServiceName(serviceName);
  const expectedMessage = String(message || "").trim();
  const expectedPackage = normalizedServiceName(packageName);
  const expectedImageUrl = String(imageUrl || "").trim();
  if (!serviceKey || !expectedMessage) return false;

  const matches = getActivePromotions(clinicConfig.promotions || []).filter(
    (item) =>
      normalizedServiceName(item?.linkedService) === serviceKey &&
      promotionHasFollowUpMessage(item)
  );
  if (matches.length !== 1) return false;

  const [promotion] = matches;
  const configuredPackages = Array.isArray(promotion.packages)
    ? promotion.packages.filter((item) => item && typeof item === "object")
    : [];

  if (configuredPackages.length > 0) {
    if (findAmbiguousPromotionPackageTerm(promotion)) return false;
    const packages = promotionPackages(promotion);
    if (expectedPackage) {
      const matches = packages.filter(
        (item) => normalizedServiceName(item.name) === expectedPackage
      );
      return (
        matches.length === 1 &&
        promotionFollowUpTexts(matches[0]).includes(expectedMessage) &&
        String(matches[0].followUpImageUrl || "").trim() === expectedImageUrl
      );
    }
    return packages.some(
      (item) =>
        promotionFollowUpTexts(item).includes(expectedMessage) &&
        String(item.followUpImageUrl || "").trim() === expectedImageUrl
    );
  }

  return (
    promotionFollowUpTexts(promotion).includes(expectedMessage) &&
    String(promotion.followUpImageUrl || "").trim() === expectedImageUrl
  );
}

function messageForCandidate(step, candidate, language, stepIndex = 1) {
  let promotionPackageSelection = null;
  if (stepIndex === 1) {
    const promotionFollowUp = promotionFollowUpForCandidate(candidate, language);
    if (promotionFollowUp?.promotionFollowUp) return promotionFollowUp;
    promotionPackageSelection = promotionFollowUp?.packageSelection || null;
  }

  const currentService = followUpServiceContext(candidate);
  const overrideForService = (serviceName) =>
    step.serviceOverrides.find(
      (item) =>
        normalizedServiceName(item.serviceName) ===
        normalizedServiceName(serviceName)
    ) || null;

  const interest = normalizedServiceName(candidate.treatment_interest);
  const exactInterest = interest
    ? step.serviceOverrides.find(
        (item) => normalizedServiceName(item.serviceName) === interest
      )
    : null;

  // The newest customer-named service wins, even when the outbound package
  // caption lists several included services. Ambiguous customer or anchor
  // wording fails closed to the general step. CRM interest is only a fallback
  // when the current conversation does not name any configured service.
  const targeted = currentService.mentioned
    ? currentService.serviceName
      ? overrideForService(currentService.serviceName)
      : null
    : exactInterest || null;
  const source = targeted || step;
  // Service-specific media overrides the general attachment only when that
  // service actually has media configured. Otherwise keep the general media
  // as the safe fallback, preserving the existing general-image behavior.
  const targetedMedia =
    targeted && (targeted.imageUrl || targeted.videoKey) ? targeted : null;
  const mediaSource = targetedMedia || step;
  return {
    message: source.translations[language] || source.message,
    targetedService: targeted?.serviceName || null,
    targetedMediaService: targetedMedia?.serviceName || null,
    selectedImageUrl: mediaSource.imageUrl || "",
    selectedVideoKey: mediaSource.videoKey || "",
    selectedVideoFilename: mediaSource.videoFilename || "",
    promotionFollowUp: false,
    promotionPackageSelection,
  };
}

function publishConversationChange(message, reason) {
  if (!message) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: message.contact_id,
    messageId: message.id,
    whatsappMessageId: message.whatsapp_message_id,
    deliveryStatus: message.delivery_status,
    deliveryError: message.delivery_error,
    reason,
  });
}

function contactForCandidate(candidate) {
  const channel = candidate.channel || "whatsapp";
  return {
    id: candidate.contact_id,
    channel,
    whatsapp_number: candidate.whatsapp_number,
    channel_user_id: candidate.channel_user_id,
  };
}

function rejectedFollowUpError(channel) {
  return `${channelMessaging.labelForChannel(channel)} did not accept this automated follow-up. Check the reply window or connection and retry it from the Inbox.`;
}

function deliveryErrorFor(channel, sendResult, rejectedError) {
  // Policy/final-eligibility failures contain a useful reason staff need to
  // see. Other provider failures keep the existing channel-specific wording.
  return sendResult?.error &&
    (sendResult?.policyBlocked || sendResult?.preSendCheckFailed)
    ? sendResult.error
    : rejectedError;
}

async function markContacted(contactId) {
  try {
    await pipelineRepo.markContactedForContact(
      contactId,
      "Automated follow-up"
    );
  } catch (err) {
    console.error(
      `Failed to mark lead ${contactId} as contacted after automated follow-up:`,
      err
    );
  }
}

async function sendSocialImageCompanion(contact, contactId, imageUrl, quietHours) {
  if (quietHoursStatus(new Date(), quietHours).active) return;

  let imageMessage;
  try {
    imageMessage = await followUpRepo.saveSocialImageCompanion({
      contactId,
      imageUrl,
    });
  } catch (err) {
    console.error(
      `Failed to save optional social follow-up image for contact ${contactId}:`,
      err
    );
    await contactsRepo.setDeliveryAttention(
      contactId,
      "Follow-up text was sent, but the optional follow-up graphic could not be queued."
    );
    return;
  }

  if (!imageMessage) return;
  publishConversationChange(imageMessage, "message");

  let imageResult;
  try {
    // Facebook Messenger and Instagram cannot attach caption text to this
    // image in the same API message. The follow-up text has already been sent
    // and recorded, so this companion must contain only the image. A retry can
    // then resend the image without duplicating the customer-facing text.
    const imageProviderRecorder = messagesRepo.socialProviderAliasRecorder(
      imageMessage.id,
      contact.channel
    );
    imageResult = await channelMessaging.sendImageByUrl(
      contact,
      imageUrl,
      undefined,
      {
        purpose: "marketing",
        preSendCheck: async () =>
          !quietHoursStatus(new Date(), quietHours).active,
        ...(imageProviderRecorder
          ? { onProviderMessageId: imageProviderRecorder }
          : {}),
      }
    );
  } catch (err) {
    console.error("Optional social follow-up image send failed:", err);
    imageResult = { success: false, wamid: null, externalMessageId: null };
  }

  if (imageResult?.cancelled && !imageResult?.preSendCheckFailed) {
    const discarded = await followUpRepo.discardUnsentSocialImageCompanion({
      messageId: imageMessage.id,
      contactId,
    });
    if (discarded) {
      publishConversationChange(discarded, "message_cancelled");
    }
    return;
  }

  const imageError = imageResult?.policyBlocked && imageResult.error
    ? imageResult.error
    : `${channelMessaging.labelForChannel(contact.channel)} did not accept the optional follow-up graphic. The follow-up text was sent; retry this image from the Inbox if needed.`;
  let finalImageMessage = imageMessage;
  if (imageResult?.success && imageResult.externalMessageId) {
    finalImageMessage =
      (await messagesRepo.setSocialProviderMessageId(
        imageMessage.id,
        `${contact.channel}:${imageResult.externalMessageId}`,
        "sent"
      )) || imageMessage;
  } else {
    finalImageMessage =
      (await messagesRepo.setDeliveryStatusById(
        imageMessage.id,
        imageResult?.success ? "sent" : "failed",
        imageResult?.success ? null : imageError
      )) || imageMessage;
  }
  publishConversationChange(finalImageMessage, "delivery_status");

  if (!imageResult?.success) {
    await contactsRepo.setDeliveryAttention(
      contactId,
      `Delivery failed: ${imageError}`
    );
  }
}

async function sendSocialVideoCompanion(
  contact,
  contactId,
  sourceVideoKey,
  filename,
  quietHours
) {
  if (quietHoursStatus(new Date(), quietHours).active) return;

  let durableVideoKey = null;
  try {
    durableVideoKey = await mediaStorage.copyStoredMediaToMessage(
      sourceVideoKey,
      "video/mp4",
      { contactId }
    );
  } catch (err) {
    console.error(
      `Failed to prepare optional social follow-up video for contact ${contactId}:`,
      err
    );
    await contactsRepo.setDeliveryAttention(
      contactId,
      "Follow-up text was sent, but the service video could not be prepared."
    );
    return;
  }

  let videoMessage;
  try {
    videoMessage = await followUpRepo.saveSocialVideoCompanion({
      contactId,
      mediaKey: durableVideoKey,
      mediaMimeType: "video/mp4",
    });
  } catch (err) {
    console.error(
      `Failed to save optional social follow-up video for contact ${contactId}:`,
      err
    );
    await mediaStorage.deleteMedia(durableVideoKey).catch((cleanupErr) => {
      console.error(
        `Failed to clean up unsaved social follow-up video ${durableVideoKey}:`,
        cleanupErr
      );
    });
    await contactsRepo.setDeliveryAttention(
      contactId,
      "Follow-up text was sent, but the service video could not be queued."
    );
    return;
  }

  if (!videoMessage) {
    await mediaStorage.deleteMedia(durableVideoKey).catch((cleanupErr) => {
      console.error(
        `Failed to clean up unclaimed social follow-up video ${durableVideoKey}:`,
        cleanupErr
      );
    });
    return;
  }

  publishConversationChange(videoMessage, "message");

  let videoResult;
  try {
    const videoProviderRecorder = messagesRepo.socialProviderAliasRecorder(
      videoMessage.id,
      contact.channel
    );
    videoResult = await channelMessaging.sendVideoByStoredKey(
      contact,
      durableVideoKey,
      undefined,
      filename || "service-video.mp4",
      {
        purpose: "marketing",
        preSendCheck: async () =>
          !quietHoursStatus(new Date(), quietHours).active,
        ...(videoProviderRecorder
          ? { onProviderMessageId: videoProviderRecorder }
          : {}),
      }
    );
  } catch (err) {
    console.error("Optional social follow-up video send failed:", err);
    videoResult = { success: false, wamid: null, externalMessageId: null };
  }

  if (videoResult?.cancelled && !videoResult?.preSendCheckFailed) {
    const discarded = await followUpRepo.discardUnsentSocialVideoCompanion({
      messageId: videoMessage.id,
      contactId,
    });
    if (discarded) {
      await mediaStorage.deleteMedia(durableVideoKey).catch((cleanupErr) => {
        console.error(
          `Failed to clean up cancelled social follow-up video ${durableVideoKey}:`,
          cleanupErr
        );
      });
      publishConversationChange(discarded, "message_cancelled");
    }
    return;
  }

  const videoError =
    videoResult?.policyBlocked && videoResult.error
      ? videoResult.error
      : `${channelMessaging.labelForChannel(contact.channel)} did not accept the optional service video. The follow-up text was sent; retry this video from the Inbox if needed.`;
  let finalVideoMessage = videoMessage;
  if (videoResult?.success && videoResult.externalMessageId) {
    finalVideoMessage =
      (await messagesRepo.setSocialProviderMessageId(
        videoMessage.id,
        `${contact.channel}:${videoResult.externalMessageId}`,
        "sent"
      )) || videoMessage;
  } else {
    finalVideoMessage =
      (await messagesRepo.setDeliveryStatusById(
        videoMessage.id,
        videoResult?.success ? "sent" : "failed",
        videoResult?.success ? null : videoError
      )) || videoMessage;
  }
  publishConversationChange(finalVideoMessage, "delivery_status");

  if (!videoResult?.success) {
    await contactsRepo.setDeliveryAttention(
      contactId,
      `Delivery failed: ${videoError}`
    );
  }
}

async function releaseAiGenerationLease({
  contactId,
  triggerMessageId,
  stepIndex,
  leaseToken,
}) {
  if (!leaseToken) return;
  try {
    await followUpAiLeaseRepo.release({
      contactId,
      triggerMessageId,
      stepIndex,
      leaseToken,
    });
  } catch (err) {
    console.error(
      `Failed to release AI follow-up generation lease for contact ${contactId}:`,
      err
    );
  }
}

function currentSessionHasPromotionEnquiry(
  messages,
  triggerMessageId,
  serviceName
) {
  const target = normalizedServiceName(serviceName);
  if (!target) return false;

  const scoped = followUpAiService.scopePackageSelectionConversation(
    messages,
    triggerMessageId
  );
  let currentCustomerService = null;
  let targetPromotionEnquirySeen = false;
  let genericPromotionEnquirySeen = false;
  let incompatibleServiceSeen = false;

  for (const message of scoped) {
    if (message?.role !== "user") continue;

    const service = mostSpecificConfiguredServiceInText(message.content);
    if (service.mentioned) {
      if (!service.serviceName) {
        currentCustomerService = null;
        incompatibleServiceSeen = true;
      } else {
        currentCustomerService = normalizedServiceName(service.serviceName);
        if (currentCustomerService !== target) {
          incompatibleServiceSeen = true;
        }
      }
    }

    if (!looksLikePromotionEnquiry(message?.content)) continue;

    if (service.mentioned) {
      if (service.serviceName && currentCustomerService === target) {
        targetPromotionEnquirySeen = true;
      }
      continue;
    }

    // Real chats commonly establish the service in one turn and then ask only
    // "多少钱？" / "price?". Carry that customer-only service context into the
    // generic price turn.
    if (currentCustomerService) {
      if (currentCustomerService === target) {
        targetPromotionEnquirySeen = true;
      }
      continue;
    }

    // With no customer-spoken service yet (for example a Meta ad already set
    // the structured treatment interest), remember the generic price enquiry.
    // It is usable only if the rest of this scoped session never introduces a
    // competing/ambiguous service.
    genericPromotionEnquirySeen = true;
  }

  // Fail closed if the customer explicitly moved to another/ambiguous service
  // anywhere in this current session. The normal follow-up is safer than
  // reviving a hidden offer for stale CRM interest.
  if (incompatibleServiceSeen) return false;

  return targetPromotionEnquirySeen || genericPromotionEnquirySeen;
}

async function sendCandidate(candidate) {
  // Read the live settings again for every candidate. A staff member may
  // pause the tool or make its criteria stricter while a sweep is running.
  const settings = getActiveSettings();
  if (!settings) return;

  const stepIndex = Number(candidate.next_follow_up_step) || 1;
  const step = settings.steps[stepIndex - 1];
  if (!step) return;

  // A sweep can begin just before quiet hours start. Re-check before claiming
  // so we never create an outbound row that should simply wait until morning.
  if (quietHoursStatus(new Date(), settings.quietHours).active) return;

  const language = detectConversationLanguage([
    ...(candidate.recent_inbound_messages || []),
    candidate.trigger_message_content,
  ]);
  const fallbackSelection = messageForCandidate(
    step,
    candidate,
    language,
    stepIndex
  );
  let followUpMessage = fallbackSelection.message;
  let targetedService = fallbackSelection.targetedService;
  let targetedMediaService = fallbackSelection.targetedMediaService || null;
  let selectedImageUrl = fallbackSelection.selectedImageUrl || "";
  let selectedVideoKey = fallbackSelection.selectedVideoKey || "";
  let selectedVideoFilename =
    fallbackSelection.selectedVideoFilename || "";
  let promotionFollowUp = fallbackSelection.promotionFollowUp === true;
  let promotionPackageName = fallbackSelection.promotionPackageName || null;
  let promotionFollowUpImageUrl =
    fallbackSelection.promotionFollowUpImageUrl || "";
  const promotionPackageSelection =
    fallbackSelection.promotionPackageSelection || null;

  let followUpMessageMode = "fixed";
  let aiLeaseToken = null;
  const needsAiWork =
    Boolean(promotionPackageSelection) ||
    (step.messageMode === "ai" && !promotionFollowUp);

  if (needsAiWork) {
    aiLeaseToken = randomUUID();
    const lease = await followUpAiLeaseRepo.claimIfStillEligible({
      contactId: candidate.contact_id,
      triggerMessageId: candidate.trigger_message_id,
      stepIndex,
      leaseToken: aiLeaseToken,
      delayMinutes: step.delayMinutes,
      previousDelayMinutes:
        stepIndex > 1 ? settings.steps[stepIndex - 2].delayMinutes : 0,
      timingMode: step.timingMode,
      beforeWindowExpiryMinutes: step.beforeWindowExpiryMinutes,
      quietHours: settings.quietHours,
      triggerMode: settings.triggerMode,
      activatedAt: settings.activatedAt,
    });
    if (!lease) return;

    let aiContext = null;
    try {
      aiContext = await followUpRepo.getAiFollowUpContext({
        contactId: candidate.contact_id,
      });
    } catch (err) {
      console.error(
        `AI follow-up context load failed for contact ${candidate.contact_id}; using reviewed fallback:`,
        err
      );
    }

    const packagePromotionContextAllowed =
      Boolean(promotionPackageSelection) &&
      Boolean(aiContext) &&
      (
        promotionPackageSelection.requiresRecentPromotionEnquiry !== true ||
        currentSessionHasPromotionEnquiry(
          aiContext.messages,
          candidate.trigger_message_id,
          promotionPackageSelection.serviceName
        )
      );

    if (packagePromotionContextAllowed) {
      try {
        const selectedPackageName =
          await followUpAiService.selectPromotionPackageForFollowUp({
            conversation: aiContext.messages,
            triggerMessageId: candidate.trigger_message_id,
            serviceName: promotionPackageSelection.serviceName,
            packages: promotionPackageSelection.packages,
            channel: candidate.channel || "whatsapp",
          });

        if (selectedPackageName) {
          const selectedKey = normalizedServiceName(selectedPackageName);
          const selectedPackages = promotionPackageSelection.packages.filter(
            (item) => normalizedServiceName(item?.name) === selectedKey
          );
          const selectedPackage =
            selectedPackages.length === 1 ? selectedPackages[0] : null;

          const selectedFollowUp = localizedPromotionFollowUp(
            selectedPackage,
            language
          );
          if (selectedFollowUp) {
            // AI chooses only the package key. Customer-facing promo wording is
            // always copied verbatim from trusted config and is never generated.
            followUpMessage = selectedFollowUp;
            targetedService = promotionPackageSelection.serviceName;
            promotionPackageName = selectedPackage.name;
            promotionFollowUpImageUrl = String(
              selectedPackage.followUpImageUrl || ""
            ).trim();
            promotionFollowUp = true;
          }
        }
      } catch (err) {
        // Package selection is optional intelligence. Any provider/JSON failure
        // falls back to the normal step rather than sending multiple offers.
        console.error(
          `AI package selection failed for contact ${candidate.contact_id}; using normal follow-up fallback:`,
          err
        );
      }
    }

    // Configured promotion copy remains exact. AI still reviews an AI-mode
    // targeted-media follow-up so skip/human-review safety decisions remain
    // active, but a send decision must not rewrite the configured caption that
    // was authored together with the service image/video.
    if (step.messageMode === "ai" && !promotionFollowUp) {
      if (!aiContext) {
        followUpMessageMode = "ai_fallback";
      } else {
        try {
          const aiDecision = await followUpAiService.generatePersonalizedFollowUp({
            conversation: aiContext.messages,
            triggerMessageId: candidate.trigger_message_id,
            stepNumber: stepIndex,
            treatmentInterest:
              aiContext.lead?.treatment_interest || candidate.treatment_interest,
            stageName: aiContext.lead?.stage_name,
            branchName: aiContext.lead?.branch_name,
            appointmentStatus: aiContext.lead?.appointment_status,
            instruction: step.aiInstruction,
            channel: candidate.channel || "whatsapp",
          });

          if (aiDecision.action !== "send") {
            const suppressStaffPromotionReview =
              aiDecision.action === "human_review" &&
              followUpAiService.shouldSuppressStaffPromotionHumanReview({
                conversation: aiContext.messages,
                triggerMessageId: candidate.trigger_message_id,
                decision: aiDecision,
              });

            if (suppressStaffPromotionReview) {
              // Staff already chose to send this ad-hoc offer. Do not persist a
              // false human-review decision just because the same offer was not
              // duplicated into Promotions. Fall back to the reviewed fixed
              // follow-up instead of trusting the model's empty review result.
              console.warn(
                `Suppressed promotion-config-only AI human review for staff-authored follow-up anchor ${candidate.trigger_message_id}.`
              );
              followUpMessageMode = "ai_fallback";
            } else {
              let recorded = null;
              try {
                recorded = await followUpRepo.recordAiDecisionIfStillEligible({
                  contactId: candidate.contact_id,
                  triggerMessageId: candidate.trigger_message_id,
                  stepIndex,
                  action: aiDecision.action,
                  reason: aiDecision.reason,
                  topic: aiDecision.topic,
                  delayMinutes: step.delayMinutes,
                  previousDelayMinutes:
                    stepIndex > 1 ? settings.steps[stepIndex - 2].delayMinutes : 0,
                  timingMode: step.timingMode,
                  beforeWindowExpiryMinutes: step.beforeWindowExpiryMinutes,
                  quietHours: settings.quietHours,
                  triggerMode: settings.triggerMode,
                  activatedAt: settings.activatedAt,
                });
              } finally {
                await releaseAiGenerationLease({
                  contactId: candidate.contact_id,
                  triggerMessageId: candidate.trigger_message_id,
                  stepIndex,
                  leaseToken: aiLeaseToken,
                });
                aiLeaseToken = null;
              }

              // A customer or staff reply may have arrived while the model was
              // generating. In that case the old anchor is no longer eligible and
              // the decision is discarded instead of affecting the new conversation.
              if (!recorded) return;

              if (aiDecision.action === "human_review") {
                try {
                  await contactsRepo.setAttention(
                    candidate.contact_id,
                    true,
                    `AI follow-up requested human review: ${aiDecision.reason || "Staff should review this conversation before any follow-up."}`
                  );
                } catch (err) {
                  console.error(
                    `Failed to publish AI follow-up human review for contact ${candidate.contact_id}:`,
                    err
                  );
                }
              }
              return;
            }
          } else if (targetedMediaService) {
            // Keep the exact configured caption paired with the selected
            // service media. The model has approved sending, but its generated
            // prose is intentionally ignored for this targeted attachment.
            followUpMessageMode = "fixed";
          } else {
            followUpMessage = aiDecision.message;
            followUpMessageMode = "ai_personalized";
          }
        } catch (err) {
          followUpMessageMode = "ai_fallback";
          console.error(
            `AI follow-up generation failed for contact ${candidate.contact_id}; using fixed fallback:`,
            err
          );
        }
      }
    }
  }

  // AI generation can take several seconds. If quiet hours began meanwhile,
  // leave the conversation untouched so the normal worker wake can resume it
  // after the quiet window instead of creating an unsent claim.
  if (quietHoursStatus(new Date(), settings.quietHours).active) {
    if (aiLeaseToken) {
      await releaseAiGenerationLease({
        contactId: candidate.contact_id,
        triggerMessageId: candidate.trigger_message_id,
        stepIndex,
        leaseToken: aiLeaseToken,
      });
    }
    return;
  }

  const contact = contactForCandidate(candidate);
  const channel = contact.channel || "whatsapp";
  const isSocial = channel === "facebook" || channel === "instagram";
  // A promotion override replaces the normal step content. Use only the
  // matched promotion/package follow-up graphic; never fall back to the
  // generic step image because it may belong to a different offer.
  const effectiveImageUrl = promotionFollowUp
    ? promotionFollowUpImageUrl
    : selectedImageUrl;
  const effectiveVideoKey =
    !promotionFollowUp && selectedVideoKey ? selectedVideoKey : "";
  const effectiveVideoFilename =
    selectedVideoFilename || "follow-up-video.mp4";

  // WhatsApp keeps the video on the same durable follow-up row so Inbox
  // history and Retry can resend the exact attachment. Copy the shared config
  // object into the contact's media namespace before claiming the row.
  let durableVideoKey = null;
  if (!isSocial && effectiveVideoKey) {
    try {
      durableVideoKey = await mediaStorage.copyStoredMediaToMessage(
        effectiveVideoKey,
        "video/mp4",
        { contactId: candidate.contact_id }
      );
    } catch (err) {
      console.error(
        `Failed to prepare follow-up video for contact ${candidate.contact_id}:`,
        err
      );
      await contactsRepo.setDeliveryAttention(
        candidate.contact_id,
        "Automated follow-up paused because the service video could not be prepared."
      );
      return;
    }
  }

  // WhatsApp can send its media + caption as one tracked message. Messenger
  // and Instagram keep the sequence claim as text and persist media companions
  // separately so either provider message can be retried without duplication.
  let saved;
  try {
    saved = await followUpRepo.saveIfStillEligible({
      contactId: candidate.contact_id,
      triggerMessageId: candidate.trigger_message_id,
      content: followUpMessage,
      mediaUrl: !isSocial && effectiveImageUrl ? effectiveImageUrl : null,
      mediaKey: durableVideoKey,
      mediaMimeType: durableVideoKey ? "video/mp4" : null,
      stepIndex,
      targetedService:
        followUpMessageMode === "ai_personalized"
          ? targetedMediaService
          : targetedService,
      messageMode: followUpMessageMode,
      delayMinutes: step.delayMinutes,
      previousDelayMinutes:
        stepIndex > 1 ? settings.steps[stepIndex - 2].delayMinutes : 0,
      timingMode: step.timingMode,
      beforeWindowExpiryMinutes: step.beforeWindowExpiryMinutes,
      quietHours: settings.quietHours,
      triggerMode: settings.triggerMode,
      activatedAt: settings.activatedAt,
    });
  } catch (err) {
    if (durableVideoKey) {
      await mediaStorage.deleteMedia(durableVideoKey).catch((cleanupErr) => {
        console.error(
          `Failed to clean up unclaimed follow-up video ${durableVideoKey}:`,
          cleanupErr
        );
      });
    }
    throw err;
  } finally {
    if (aiLeaseToken) {
      await releaseAiGenerationLease({
        contactId: candidate.contact_id,
        triggerMessageId: candidate.trigger_message_id,
        stepIndex,
        leaseToken: aiLeaseToken,
      });
      aiLeaseToken = null;
    }
  }

  // The customer may have replied since the candidate query, or another
  // server instance may already have claimed this exact trigger.
  if (!saved) {
    if (durableVideoKey) {
      await mediaStorage.deleteMedia(durableVideoKey).catch((cleanupErr) => {
        console.error(
          `Failed to clean up unused follow-up video ${durableVideoKey}:`,
          cleanupErr
        );
      });
    }
    return;
  }

  publishConversationChange(saved, "message");

  const rejectedError = rejectedFollowUpError(channel);

  const finalPreSendCheck = async () => {
    const liveSettings = getActiveSettings();
    const liveStep = liveSettings?.steps?.[stepIndex - 1];
    if (
      !liveSettings ||
      !liveStep ||
      liveSettings.activatedAt !== settings.activatedAt ||
      liveSettings.triggerMode !== settings.triggerMode ||
      JSON.stringify(liveStep) !== JSON.stringify(step) ||
      quietHoursStatus(new Date(), liveSettings.quietHours).active ||
      (promotionFollowUp &&
        !activePromotionFollowUpStillConfigured(
          targetedService,
          followUpMessage,
          promotionPackageName,
          promotionFollowUpImageUrl
        ))
    ) {
      return false;
    }

    return followUpRepo.isClaimStillEligible({
      messageId: saved.id,
      contactId: candidate.contact_id,
    });
  };

  let sendResult;
  try {
    if (isSocial) {
      // Record the follow-up text separately from an optional image so an image
      // failure/retry can never duplicate a text message Meta already accepted.
      const textProviderRecorder = messagesRepo.socialProviderAliasRecorder(
        saved.id,
        channel
      );
      sendResult = await channelMessaging.sendText(
        contact,
        followUpMessage,
        {
          purpose: "marketing",
          preSendCheck: finalPreSendCheck,
          ...(textProviderRecorder
            ? { onProviderMessageId: textProviderRecorder }
            : {}),
        }
      );
    } else {
      const policyOptions = {
        purpose: "marketing",
        preSendCheck: finalPreSendCheck,
      };
      sendResult = effectiveVideoKey
        ? await channelMessaging.sendVideoByStoredKey(
            contact,
            durableVideoKey,
            followUpMessage,
            effectiveVideoFilename,
            policyOptions
          )
        : effectiveImageUrl
          ? await channelMessaging.sendImageByUrl(
              contact,
              effectiveImageUrl,
              followUpMessage,
              policyOptions
            )
          : await channelMessaging.sendText(
              contact,
              followUpMessage,
              policyOptions
            );
    }
  } catch (err) {
    console.error("Automated follow-up send failed:", err);
    sendResult = { success: false, wamid: null, externalMessageId: null };
  }

  // A failed final database verification happens before any provider call.
  // It is safe to discard the unsent claim and retry eligibility on a later sweep.
  if (sendResult?.cancelled) {
    const discarded = await followUpRepo.discardUnsentClaim({
      messageId: saved.id,
      contactId: candidate.contact_id,
    });
    if (discarded) {
      if (durableVideoKey) {
        await mediaStorage.deleteMedia(durableVideoKey).catch((cleanupErr) => {
          console.error(
            `Failed to clean up cancelled follow-up video ${durableVideoKey}:`,
            cleanupErr
          );
        });
      }
      publishConversationChange(discarded, "message_cancelled");
    }
    return;
  }

  const deliveryError = deliveryErrorFor(channel, sendResult, rejectedError);
  let finalMessage = saved;
  if (sendResult?.wamid) {
    // WhatsApp keeps using its asynchronous WAMID delivery-status pipeline.
    finalMessage =
      (await messagesRepo.setWhatsappMessageId(saved.id, sendResult.wamid)) || saved;
  } else if (!sendResult?.success) {
    finalMessage =
      (await messagesRepo.setDeliveryStatusById(
        saved.id,
        "failed",
        deliveryError
      )) || saved;
  } else if (isSocial) {
    // Keep Meta's provider id for echo dedupe without entering WhatsApp's
    // asynchronous delivery-status pipeline.
    finalMessage = sendResult.externalMessageId
      ? (await messagesRepo.setSocialProviderMessageId(
          saved.id,
          `${channel}:${sendResult.externalMessageId}`,
          "sent"
        )) || saved
      : (await messagesRepo.setDeliveryStatusById(saved.id, "sent", null)) || saved;
  }

  publishConversationChange(finalMessage, "delivery_status");

  if (!sendResult?.success) {
    await contactsRepo.setDeliveryAttention(
      candidate.contact_id,
      `Delivery failed: ${deliveryError}`
    );
    return;
  }

  // The successful text/WhatsApp follow-up is enough to move a new lead to
  // Contacted. Optional social image delivery is tracked independently below.
  await markContacted(candidate.contact_id);

  if (isSocial && effectiveVideoKey) {
    await sendSocialVideoCompanion(
      contact,
      candidate.contact_id,
      effectiveVideoKey,
      effectiveVideoFilename,
      settings.quietHours
    );
  } else if (isSocial && effectiveImageUrl) {
    await sendSocialImageCompanion(
      contact,
      candidate.contact_id,
      effectiveImageUrl,
      settings.quietHours
    );
  }
}

async function recoverInterruptedFollowUps() {
  const recovered = await followUpRepo.markStaleClaimsUnconfirmed({
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
    limit: FOLLOW_UP_BATCH_SIZE,
  });

  for (const message of recovered) {
    publishConversationChange(message, "delivery_status");
    try {
      await contactsRepo.setDeliveryAttention(
        message.contact_id,
        `Delivery unconfirmed: ${message.delivery_error}`
      );
    } catch (err) {
      console.error(
        `Failed to flag interrupted automated follow-up ${message.id} for attention:`,
        err
      );
    }
  }
  return recovered.length;
}

async function nextInterruptedRecoveryAt() {
  if (typeof followUpRepo.getNextStaleClaimDueAt !== "function") return null;
  return followUpRepo.getNextStaleClaimDueAt({
    olderThanMinutes: STALE_CLAIM_GRACE_MINUTES,
  });
}

async function runAutomatedFollowUps({ now = new Date() } = {}) {
  if (sweepRunning) {
    return {
      enabled: Boolean(getActiveSettings()),
      candidateCount: 0,
      recoveredCount: 0,
      nextDueAt: null,
      nextRecoveryAt: null,
    };
  }

  sweepRunning = true;
  try {
    // Recovery is independent of the current tool setting. A staff member
    // may disable the tool after a restart, but an already-claimed message
    // must still become visible and retryable in the Inbox.
    const recoveredCount = await recoverInterruptedFollowUps();

    const settings = getActiveSettings();
    if (!settings) {
      return {
        enabled: false,
        candidateCount: 0,
        recoveredCount,
        nextDueAt: null,
        nextRecoveryAt: await nextInterruptedRecoveryAt(),
      };
    }

    const quiet = quietHoursStatus(now, settings.quietHours);
    if (quiet.active) {
      return {
        enabled: true,
        candidateCount: 0,
        recoveredCount,
        nextDueAt: quiet.endsAt,
        nextRecoveryAt: await nextInterruptedRecoveryAt(),
      };
    }

    const candidates = await followUpRepo.findCandidates({
      delayMinutes: settings.steps.map((step) => step.delayMinutes),
      timingModes: settings.steps.map((step) => step.timingMode),
      beforeWindowExpiryMinutes: settings.steps.map(
        (step) => step.beforeWindowExpiryMinutes
      ),
      quietHours: settings.quietHours,
      triggerMode: settings.triggerMode,
      activatedAt: settings.activatedAt,
      limit: FOLLOW_UP_BATCH_SIZE,
    });

    for (const candidate of candidates) {
      try {
        await sendCandidate(candidate);
      } catch (err) {
        console.error(
          `Failed to process automated follow-up for contact ${candidate.contact_id}:`,
          err
        );
      }
    }

    const pricingNextDueAt = await pricingReminderService.runPricingReminders(settings, now);

    const liveSettings = getActiveSettings();
    const nextDueAt = liveSettings && typeof followUpRepo.getNextCandidateDueAt === "function"
      ? await followUpRepo.getNextCandidateDueAt({
          delayMinutes: liveSettings.steps.map((step) => step.delayMinutes),
          timingModes: liveSettings.steps.map((step) => step.timingMode),
          beforeWindowExpiryMinutes: liveSettings.steps.map(
            (step) => step.beforeWindowExpiryMinutes
          ),
          quietHours: liveSettings.quietHours,
          triggerMode: liveSettings.triggerMode,
          activatedAt: liveSettings.activatedAt,
        })
      : null;
    const nextRecoveryAt = await nextInterruptedRecoveryAt();

    return {
      enabled: Boolean(liveSettings),
      candidateCount: candidates.length,
      recoveredCount,
      nextDueAt: (() => {
        const times = [nextDueAt, pricingNextDueAt]
          .filter(Boolean)
          .map((value) => new Date(value).getTime())
          .filter(Number.isFinite);
        return times.length ? new Date(Math.min(...times)).toISOString() : null;
      })(),
      nextRecoveryAt,
    };
  } catch (err) {
    console.error("Automated follow-up sweep failed:", err);
    throw err;
  } finally {
    sweepRunning = false;
  }
}

function earliestTimestamp(...values) {
  let earliest = null;
  for (const value of values) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) return NaN;
    if (earliest === null || timestamp < earliest) earliest = timestamp;
  }
  return earliest;
}

function delayUntilNextFollowUp(result) {
  const timestamp = earliestTimestamp(
    result?.enabled ? result.nextDueAt : null,
    result?.nextRecoveryAt
  );
  if (timestamp === null) return null;
  if (Number.isNaN(timestamp)) return FOLLOW_UP_CHECK_INTERVAL_MS;
  // Avoid a zero-delay spin if another instance wins a race between candidate
  // discovery/recovery and the atomic claim.
  return Math.max(1000, timestamp - Date.now());
}

function wakeAutomatedFollowUps(delayMs = 0) {
  return followUpTimer?.wake(delayMs) || false;
}

function startAutomatedFollowUps() {
  if (followUpTimer && !followUpTimer.state().stopped) {
    return () => followUpTimer.stop();
  }

  followUpTimer = createAdaptiveWorkerTimer({
    run: runAutomatedFollowUps,
    delayForResult: delayUntilNextFollowUp,
    errorRetryDelayMs: FOLLOW_UP_CHECK_INTERVAL_MS,
    label: "Automated follow-up worker",
  });
  return followUpTimer.start();
}

// Any conversation change can make an outbound message newly eligible or make
// an existing candidate ineligible. Recalculate while the database is already
// active; once the chat becomes quiet the worker sleeps until the exact due time.
realtimeEvents.subscribe("conversation_changed", () => {
  wakeAutomatedFollowUps(0);
});

// Pipeline changes can make a previously booked lead eligible again
// (cancelled/reschedule) or make a pending follow-up ineligible (booked/visited).
// Recalculate immediately instead of waiting for an unrelated chat event.
realtimeEvents.subscribe("pipeline_changed", () => {
  wakeAutomatedFollowUps(0);
});

realtimeEvents.subscribe("config_changed", (payload) => {
  if (payload?.keys?.some((key) => ["automatedFollowUp", "promotions"].includes(key))) wakeAutomatedFollowUps(0);
});

module.exports = {
  FOLLOW_UP_CHECK_INTERVAL_MS,
  STALE_CLAIM_GRACE_MINUTES,
  runAutomatedFollowUps,
  startAutomatedFollowUps,
  wakeAutomatedFollowUps,
};