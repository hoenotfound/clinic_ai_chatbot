const express = require("express");
const multer = require("multer");
const configRepo = require("../db/configRepo");
const promoImagesRepo = require("../db/promoImagesRepo");
const usersRepo = require("../db/usersRepo");
const leadDistributionRepo = require("../db/leadDistributionRepo");
const followUpTranslationService = require("../services/followUpTranslationService");
const telegramAlertService = require("../services/telegramAlertService");
const commentAutomationReadiness = require("../services/commentAutomationReadinessService");
const { normalizeIndustrySetup } = require("../config/industrySetup");
const { evaluateClientSetup } = require("../services/clientSetupService");
const { normalizeLeadDistributionConfig } = require("../utils/leadDistribution");
const { normalizeQuietHours } = require("../utils/quietHours");
const {
  findAmbiguousPromotionPackageTerm,
  findOverlappingPromotionFollowUpPair,
  findOverlappingPricePromotionPair,
} = require("../utils/activePromotion");

const router = express.Router();

const MAX_CONFIG_IMAGE_BYTES = 5 * 1024 * 1024;
const CONFIG_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CONFIG_IMAGE_BYTES },
  fileFilter: (req, file, cb) => {
    if (!CONFIG_IMAGE_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("Only JPG and PNG images are allowed."));
    }
    cb(null, true);
  },
});

function handleImageUpload(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image is too large. Please choose a file under 5MB." });
    }
    return res.status(400).json({ error: err.message || "Failed to upload image." });
  });
}

const VALIDATORS = {
  businessName: isNonEmptyString,
  businessDescription: isString,
  clinicName: isNonEmptyString,
  aiAssistantName: isNonEmptyString,
  introMessage: isNonEmptyString,
  automatedFollowUp: isAutomatedFollowUpConfig,
  commentAutomation: isCommentAutomationConfig,
  leadScoring: isLeadScoringConfig,
  leadDistribution: (v) => normalizeLeadDistributionConfig(v) !== null,
  tone: isString,
  messagingStyle: isString,
  closingPlaybook: isString,
  sop: isString,
  hours: (v) => isPlainObject(v) && isString(v.general) && isString(v.closed),
  contact: (v) =>
    isPlainObject(v) && isString(v.whatsapp) && isString(v.instagram) && isString(v.facebook) && isString(v.tiktok),
  branches: (v) =>
    Array.isArray(v) &&
    v.every((b) => isPlainObject(b) && isNonEmptyString(b.name) && isString(b.address) && isString(b.phone)),
  serviceAreas: (v) => Array.isArray(v) && v.every(isNonEmptyString),
  promotions: (v) =>
    Array.isArray(v) &&
    v.every(
      (p) =>
        isPlainObject(p) &&
        isNonEmptyString(p.name) &&
        isString(p.imageUrl) &&
        isString(p.caption) &&
        (p.linkedService === undefined || isString(p.linkedService)) &&
        (p.sendOnPriceQuery === undefined || typeof p.sendOnPriceQuery === "boolean") &&
        (
          p.followUpMessage === undefined ||
          (isString(p.followUpMessage) && p.followUpMessage.trim().length <= 1000)
        ) &&
        isPromotionFollowUpTranslations(p.followUpTranslations) &&
        (
          p.packages === undefined ||
          (
            Array.isArray(p.packages) &&
            p.packages.every(isPromotionPackage)
          )
        )
    ),
  resultMedia: (v) =>
    Array.isArray(v) && v.every(isResultMediaSet),
  services: (v) =>
    Array.isArray(v) &&
    v.every(
      (s) =>
        isPlainObject(s) &&
        isNonEmptyString(s.name) &&
        isString(s.description) &&
        isString(s.priceRange) &&
        isString(s.duration)
    ),
  serviceAliases: (v) =>
    Array.isArray(v) && v.every((a) => isPlainObject(a) && isNonEmptyString(a.alias) && isString(a.officialService)),
  faqs: (v) => Array.isArray(v) && v.every((f) => isPlainObject(f) && isNonEmptyString(f.q) && isString(f.a)),
  escalation: (v) =>
    isPlainObject(v) &&
    Array.isArray(v.outOfScopeTriggers) &&
    v.outOfScopeTriggers.every(isString) &&
    isString(v.handoffMessage) &&
    isString(v.handoffNote),
  guardrails: (v) => Array.isArray(v) && v.every(isString),
};

function isString(v) {
  return typeof v === "string";
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPromotionFollowUpTranslations(value) {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  return ["en", "ms", "zh"].every(
    (key) =>
      value[key] === undefined ||
      (isString(value[key]) && value[key].trim().length <= 1000)
  );
}

function hasPromotionFollowUpCopy(value) {
  if (isString(value?.followUpMessage) && value.followUpMessage.trim()) return true;
  if (!isPlainObject(value?.followUpTranslations)) return false;
  return ["en", "ms", "zh"].some(
    (key) => isString(value.followUpTranslations[key]) && value.followUpTranslations[key].trim()
  );
}

function isPromotionPackage(value) {
  return (
    isPlainObject(value) &&
    isNonEmptyString(value.name) &&
    (value.title === undefined || isString(value.title)) &&
    (
      value.aliases === undefined ||
      (Array.isArray(value.aliases) && value.aliases.every(isString))
    ) &&
    isString(value.imageUrl) &&
    isString(value.caption) &&
    (
      value.followUpMessage === undefined ||
      (isString(value.followUpMessage) && value.followUpMessage.trim().length <= 1000)
    ) &&
    isPromotionFollowUpTranslations(value.followUpTranslations)
  );
}

function isResultMediaItem(value) {
  return (
    isPlainObject(value) &&
    isNonEmptyString(value.imageUrl) &&
    isNonEmptyString(value.caption)
  );
}

function isResultMediaSet(value) {
  const hasValidTriggerMode =
    ["off", "price_only", "service_enquiry"].includes(value?.triggerMode);
  const hasLegacyTrigger =
    value?.triggerMode === undefined && typeof value?.sendAfterPrice === "boolean";

  return (
    isPlainObject(value) &&
    isNonEmptyString(value.service) &&
    typeof value.enabled === "boolean" &&
    (hasValidTriggerMode || hasLegacyTrigger) &&
    (
      value.autoSendCount === undefined ||
      (Number.isInteger(value.autoSendCount) &&
        value.autoSendCount >= 1 &&
        value.autoSendCount <= 2)
    ) &&
    Array.isArray(value.items) &&
    value.items.length >= 1 &&
    value.items.length <= 10 &&
    value.items.every(isResultMediaItem)
  );
}

function decorateConfig(config) {
  const normalizedConfig = {
    ...config,
    industrySetup: normalizeIndustrySetup(config?.industrySetup),
  };
  return {
    ...normalizedConfig,
    clientSetup: evaluateClientSetup(normalizedConfig),
  };
}

function isFollowUpTranslations(value) {
  return (
    isPlainObject(value) &&
    ["en", "ms", "zh"].every(
      (key) => isNonEmptyString(value[key]) && value[key].trim().length <= 1000
    )
  );
}

function isFollowUpServiceOverride(value) {
  return (
    isPlainObject(value) &&
    isNonEmptyString(value.serviceName) &&
    value.serviceName.trim().length <= 200 &&
    isNonEmptyString(value.message) &&
    value.message.trim().length <= 1000 &&
    isFollowUpTranslations(value.translations)
  );
}

function isFollowUpStep(value) {
  return (
    isPlainObject(value) &&
    Number.isInteger(value.delayMinutes) &&
    value.delayMinutes >= 5 &&
    value.delayMinutes <= 23 * 60 &&
    ["fixed", "ai"].includes(value.messageMode) &&
    isString(value.aiInstruction) &&
    value.aiInstruction.trim().length <= 1000 &&
    isNonEmptyString(value.message) &&
    value.message.trim().length <= 1000 &&
    isFollowUpTranslations(value.translations) &&
    isString(value.imageUrl) &&
    Array.isArray(value.serviceOverrides) &&
    value.serviceOverrides.length <= 50 &&
    value.serviceOverrides.every(isFollowUpServiceOverride)
  );
}

function isAutomatedFollowUpConfig(value) {
  if (
    !isPlainObject(value) ||
    typeof value.enabled !== "boolean" ||
    !["all", "staff"].includes(value.triggerMode) ||
    !normalizeQuietHours(value.quietHours) ||
    !isFollowUpStep(value) ||
    !Array.isArray(value.additionalSteps) ||
    value.additionalSteps.length > 2 ||
    !value.additionalSteps.every(isFollowUpStep) ||
    !(value.activatedAt === null || !Number.isNaN(Date.parse(value.activatedAt)))
  ) {
    return false;
  }

  const delays = [
    value.delayMinutes,
    ...value.additionalSteps.map((step) => step.delayMinutes),
  ];
  return delays.every(
    (delay, index) => index === 0 || delay > delays[index - 1]
  );
}

function isCommentAutomationConfig(value) {
  if (!isPlainObject(value)) return false;
  const validDate =
    value.activatedAt === null || !Number.isNaN(Date.parse(value.activatedAt));
  return (
    typeof value.enabled === "boolean" &&
    typeof value.facebookEnabled === "boolean" &&
    typeof value.instagramEnabled === "boolean" &&
    typeof value.publicReplyEnabled === "boolean" &&
    typeof value.privateReplyEnabled === "boolean" &&
    ["ai", "fixed"].includes(value.publicReplyStyle) &&
    typeof value.fixedPublicReply === "string" &&
    value.fixedPublicReply.trim().length <= 300 &&
    (
      !value.enabled ||
      !value.publicReplyEnabled ||
      value.publicReplyStyle !== "fixed" ||
      isNonEmptyString(value.fixedPublicReply)
    ) &&
    typeof value.skipEmojiOnly === "boolean" &&
    typeof value.skipNestedReplies === "boolean" &&
    validDate &&
    (!value.enabled || value.facebookEnabled || value.instagramEnabled) &&
    (!value.enabled || value.publicReplyEnabled || value.privateReplyEnabled)
  );
}

function isLeadScoringConfig(value) {
  return (
    isPlainObject(value) &&
    typeof value.enabled === "boolean" &&
    Number.isInteger(value.inactivityMinutes) &&
    value.inactivityMinutes >= 5 &&
    value.inactivityMinutes <= 30 &&
    Number.isInteger(value.maxConversationMinutes) &&
    value.maxConversationMinutes >= 30 &&
    value.maxConversationMinutes <= 120 &&
    Number.isInteger(value.maxMessages) &&
    value.maxMessages >= 20 &&
    value.maxMessages <= 80 &&
    (value.activatedAt === null || !Number.isNaN(Date.parse(value.activatedAt)))
  );
}

function prepareFollowUpTranslations(requested, fallbackMessage) {
  const input = isPlainObject(requested) ? requested : {};
  return Object.fromEntries(
    ["en", "ms", "zh"].map((key) => {
      const value = typeof input[key] === "string" ? input[key].trim() : "";
      return [key, value || fallbackMessage];
    })
  );
}

function prepareFollowUpServiceOverrides(requested) {
  if (requested === undefined) return [];
  if (!Array.isArray(requested) || requested.length > 50) return null;

  const seen = new Set();
  const prepared = [];
  for (const item of requested) {
    if (!isPlainObject(item)) return null;
    const serviceName =
      typeof item.serviceName === "string" ? item.serviceName.trim() : "";
    const message =
      typeof item.message === "string" ? item.message.trim() : "";
    const translations = prepareFollowUpTranslations(
      item.translations,
      message
    );
    const normalizedService = serviceName.toLocaleLowerCase();

    if (
      !serviceName ||
      serviceName.length > 200 ||
      !message ||
      message.length > 1000 ||
      !isFollowUpTranslations(translations) ||
      seen.has(normalizedService)
    ) {
      return null;
    }
    seen.add(normalizedService);
    prepared.push({ serviceName, message, translations });
  }
  return prepared;
}

function prepareFollowUpStep(requested) {
  if (!isPlainObject(requested)) return null;

  const delayMinutes = Number(requested.delayMinutes);
  const messageMode = requested.messageMode === "ai" ? "ai" : "fixed";
  const aiInstruction =
    typeof requested.aiInstruction === "string"
      ? requested.aiInstruction.trim()
      : "";
  const message =
    typeof requested.message === "string" ? requested.message.trim() : "";
  const translations = prepareFollowUpTranslations(
    requested.translations,
    message
  );
  const imageUrl =
    typeof requested.imageUrl === "string" ? requested.imageUrl.trim() : "";
  const serviceOverrides = prepareFollowUpServiceOverrides(
    requested.serviceOverrides
  );

  const prepared = {
    delayMinutes,
    messageMode,
    aiInstruction,
    message,
    translations,
    imageUrl,
    serviceOverrides,
  };
  return serviceOverrides && isFollowUpStep(prepared) ? prepared : null;
}

function followUpTargetedServiceNames(value) {
  if (!isPlainObject(value)) return [];
  const steps = [
    value,
    ...(Array.isArray(value.additionalSteps) ? value.additionalSteps : []),
  ];
  return steps.flatMap((step) =>
    Array.isArray(step?.serviceOverrides)
      ? step.serviceOverrides
          .map((item) => String(item?.serviceName || "").trim())
          .filter(Boolean)
      : []
  );
}

function prepareAutomatedFollowUpConfig(requested, current) {
  if (!isPlainObject(requested)) return null;

  const enabled = requested.enabled;
  const triggerMode = requested.triggerMode;
  const quietHours = normalizeQuietHours(requested.quietHours);
  const firstStep = prepareFollowUpStep(requested);
  const additionalInput =
    requested.additionalSteps === undefined ? [] : requested.additionalSteps;

  if (
    typeof enabled !== "boolean" ||
    !["all", "staff"].includes(triggerMode) ||
    !quietHours ||
    !firstStep ||
    !Array.isArray(additionalInput) ||
    additionalInput.length > 2
  ) {
    return null;
  }

  const additionalSteps = additionalInput.map(prepareFollowUpStep);
  if (additionalSteps.some((step) => !step)) return null;

  const allSteps = [firstStep, ...additionalSteps];
  for (let index = 1; index < allSteps.length; index += 1) {
    if (allSteps[index].delayMinutes <= allSteps[index - 1].delayMinutes) {
      return null;
    }
  }

  const requestedDelays = allSteps.map((step) => step.delayMinutes);
  const currentAdditionalSteps = Array.isArray(current?.additionalSteps)
    ? current.additionalSteps
    : [];
  const currentDelays = [
    Number(current?.delayMinutes),
    ...currentAdditionalSteps.map((step) => Number(step?.delayMinutes)),
  ];
  const scheduleUnchanged =
    currentDelays.length === requestedDelays.length &&
    currentDelays.every((delay, index) => delay === requestedDelays[index]);
  const triggerModeUnchanged = current?.triggerMode === triggerMode;

  // A timing/sequence change or trigger-mode change can make an old silent
  // conversation immediately eligible. Start a fresh activation window in
  // either case so configuration changes never create surprise retroactive
  // sends. Message/translation/targeting edits keep the current activation.
  const continuingCurrentActivation =
    enabled &&
    current?.enabled === true &&
    scheduleUnchanged &&
    triggerModeUnchanged &&
    typeof current.activatedAt === "string" &&
    !Number.isNaN(Date.parse(current.activatedAt));

  return {
    enabled,
    triggerMode,
    quietHours,
    ...firstStep,
    additionalSteps,
    activatedAt: enabled
      ? continuingCurrentActivation
        ? current.activatedAt
        : new Date().toISOString()
      : null,
  };
}

function prepareCommentAutomationConfig(requested, current) {
  if (!isPlainObject(requested)) return null;

  const enabled = requested.enabled === true;
  const prepared = {
    enabled,
    facebookEnabled: requested.facebookEnabled === true,
    instagramEnabled: requested.instagramEnabled === true,
    publicReplyEnabled: requested.publicReplyEnabled === true,
    privateReplyEnabled: requested.privateReplyEnabled === true,
    publicReplyStyle: requested.publicReplyStyle === "fixed" ? "fixed" : "ai",
    fixedPublicReply:
      typeof requested.fixedPublicReply === "string"
        ? requested.fixedPublicReply.trim()
        : "",
    skipEmojiOnly: requested.skipEmojiOnly !== false,
    skipNestedReplies: requested.skipNestedReplies !== false,
    activatedAt: null,
  };

  const continuingCurrentActivation =
    enabled &&
    current?.enabled === true &&
    typeof current.activatedAt === "string" &&
    !Number.isNaN(Date.parse(current.activatedAt));

  prepared.activatedAt = enabled
    ? continuingCurrentActivation
      ? current.activatedAt
      : new Date().toISOString()
    : null;

  return isCommentAutomationConfig(prepared) ? prepared : null;
}

function prepareLeadScoringConfig(requested, current) {
  if (!isPlainObject(requested)) return null;

  const prepared = {
    enabled: requested.enabled,
    inactivityMinutes: Number(requested.inactivityMinutes),
    maxConversationMinutes: Number(requested.maxConversationMinutes),
    maxMessages: Number(requested.maxMessages),
    activatedAt: null,
  };
  if (!isLeadScoringConfig(prepared)) return null;

  const continuingCurrentActivation =
    prepared.enabled &&
    current?.enabled === true &&
    typeof current.activatedAt === "string" &&
    !Number.isNaN(Date.parse(current.activatedAt));

  prepared.activatedAt = prepared.enabled
    ? continuingCurrentActivation
      ? current.activatedAt
      : new Date().toISOString()
    : null;
  return prepared;
}

function prepareConfigUpdatePayload(input, currentConfig = configRepo.getConfig()) {
  if (!isPlainObject(input)) {
    return { ok: false, status: 400, error: "Configuration must be a JSON object." };
  }

  const updates = { ...input };
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return { ok: false, status: 400, error: "No settings provided." };
  }

  const unknownKeys = keys.filter((key) => !VALIDATORS[key]);
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Unknown setting(s): ${unknownKeys.join(", ")}`,
      unknownKeys,
    };
  }

  if (Object.prototype.hasOwnProperty.call(updates, "automatedFollowUp")) {
    const prepared = prepareAutomatedFollowUpConfig(
      updates.automatedFollowUp,
      currentConfig.automatedFollowUp
    );
    if (!prepared) {
      return {
        ok: false,
        status: 400,
        error: "Invalid automated follow-up settings. Check quiet hours and use 1 to 3 steps with increasing delays between 5 minutes and 23 hours.",
      };
    }
    updates.automatedFollowUp = prepared;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "commentAutomation")) {
    const prepared = prepareCommentAutomationConfig(
      updates.commentAutomation,
      currentConfig.commentAutomation
    );
    if (!prepared) {
      return {
        ok: false,
        status: 400,
        error: "Invalid comment automation settings. Enable at least one channel and one reply action.",
      };
    }
    updates.commentAutomation = prepared;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "leadScoring")) {
    const prepared = prepareLeadScoringConfig(
      updates.leadScoring,
      currentConfig.leadScoring
    );
    if (!prepared) {
      return {
        ok: false,
        status: 400,
        error: "Invalid lead scoring settings. Check the inactivity, duration, and message limits.",
      };
    }
    updates.leadScoring = prepared;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "leadDistribution")) {
    const prepared = normalizeLeadDistributionConfig(updates.leadDistribution);
    if (!prepared) {
      return {
        ok: false,
        status: 400,
        error: "Invalid lead distribution settings. Round robin is the supported distribution method.",
      };
    }
    updates.leadDistribution = prepared;
  }

  const invalidKeys = keys.filter((key) => !VALIDATORS[key](updates[key]));
  if (invalidKeys.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Invalid value for: ${invalidKeys.join(", ")}`,
      invalidKeys,
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "services") ||
    Object.prototype.hasOwnProperty.call(updates, "automatedFollowUp")
  ) {
    const services = Object.prototype.hasOwnProperty.call(updates, "services")
      ? updates.services
      : currentConfig.services;
    const followUp = Object.prototype.hasOwnProperty.call(updates, "automatedFollowUp")
      ? updates.automatedFollowUp
      : currentConfig.automatedFollowUp;
    const configuredServiceNames = new Set(
      (Array.isArray(services) ? services : [])
        .map((service) => String(service?.name || "").trim().toLocaleLowerCase())
        .filter(Boolean)
    );
    const staleTarget = followUpTargetedServiceNames(followUp).find(
      (serviceName) => !configuredServiceNames.has(serviceName.toLocaleLowerCase())
    );
    if (staleTarget) {
      return {
        ok: false,
        status: 400,
        error:
          `Follow-up targeting still references "${staleTarget}", which is not a configured service. Remap or remove that targeted follow-up before saving the service change.`,
        invalidKeys: ["automatedFollowUp"],
      };
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "resultMedia") ||
    Object.prototype.hasOwnProperty.call(updates, "services")
  ) {
    const services = Object.prototype.hasOwnProperty.call(updates, "services")
      ? updates.services
      : currentConfig.services;
    const resultMedia = Object.prototype.hasOwnProperty.call(updates, "resultMedia")
      ? updates.resultMedia
      : currentConfig.resultMedia;
    const serviceNames = new Set(
      (Array.isArray(services) ? services : [])
        .map((service) => String(service?.name || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const seenServices = new Set();

    for (const entry of Array.isArray(resultMedia) ? resultMedia : []) {
      const service = String(entry?.service || "").trim();
      const normalized = service.toLowerCase();
      if (!service || !serviceNames.has(normalized)) {
        return {
          ok: false,
          status: 400,
          error: `Result media must link to a currently configured service. Missing service: "${service || "Unknown"}".`,
          invalidKeys: ["resultMedia"],
        };
      }
      if (seenServices.has(normalized)) {
        return {
          ok: false,
          status: 400,
          error: `Only one result media set can be configured for "${service}". Add multiple images inside that set instead.`,
          invalidKeys: ["resultMedia"],
        };
      }
      seenServices.add(normalized);
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "promotions") ||
    Object.prototype.hasOwnProperty.call(updates, "services")
  ) {
    const services = Object.prototype.hasOwnProperty.call(updates, "services")
      ? updates.services
      : currentConfig.services;
    const promotions = Object.prototype.hasOwnProperty.call(updates, "promotions")
      ? updates.promotions
      : currentConfig.promotions;
    const serviceNames = new Set(
      (Array.isArray(services) ? services : [])
        .map((service) => String(service?.name || "").trim().toLowerCase())
        .filter(Boolean)
    );

    for (const promotion of Array.isArray(promotions) ? promotions : []) {
      const packages = Array.isArray(promotion?.packages)
        ? promotion.packages
        : [];

      // Package names/titles/aliases are also used by delayed promotion
      // follow-up routing, even when immediate price-media auto-send is off.
      // Reject ambiguous wording for every package promotion at save/import
      // time instead of silently falling back at runtime.
      if (packages.length > 0) {
        const ambiguousTerm = findAmbiguousPromotionPackageTerm(promotion);
        if (ambiguousTerm) {
          return {
            ok: false,
            status: 400,
            error:
              `Package wording "${ambiguousTerm.term}" is ambiguous between "${ambiguousTerm.firstPackage}" and "${ambiguousTerm.secondPackage}". Use unique package names/titles/aliases.`,
            invalidKeys: ["promotions"],
          };
        }
      }

      const linkedService = String(promotion?.linkedService || "").trim();
      const hasFollowUpMessage =
        hasPromotionFollowUpCopy(promotion) ||
        packages.some((item) => hasPromotionFollowUpCopy(item));
      if (
        hasFollowUpMessage &&
        (!linkedService || !serviceNames.has(linkedService.toLowerCase()))
      ) {
        return {
          ok: false,
          status: 400,
          error: "Promotion follow-up copy must link to a currently configured service.",
          invalidKeys: ["promotions"],
        };
      }

      if (promotion?.sendOnPriceQuery !== true) continue;


      if (!linkedService || !serviceNames.has(linkedService.toLowerCase())) {
        return {
          ok: false,
          status: 400,
          error: "Price-triggered promotions must link to a currently configured service.",
          invalidKeys: ["promotions"],
        };
      }
      if (packages.length > 0) {
        const incompletePackage = packages.find(
          (item) =>
            !String(item?.name || "").trim() ||
            !String(item?.imageUrl || "").trim() ||
            !String(item?.caption || "").trim()
        );
        if (incompletePackage) {
          return {
            ok: false,
            status: 400,
            error: "Every automatic promotion package needs a name, image, and caption.",
            invalidKeys: ["promotions"],
          };
        }
      } else if (!String(promotion?.imageUrl || "").trim() || !String(promotion?.caption || "").trim()) {
        return {
          ok: false,
          status: 400,
          error: "Price-triggered promotions need either package options or a single image and caption.",
          invalidKeys: ["promotions"],
        };
      }
    }

    const followUpOverlap = findOverlappingPromotionFollowUpPair(promotions);
    if (followUpOverlap) {
      const [first, second] = followUpOverlap;
      return {
        ok: false,
        status: 400,
        error:
          `Only one promotion follow-up can be active for ${String(first.linkedService).trim()} at a time. ` +
          `"${first.name}" overlaps with "${second.name}". Adjust the dates or remove one delayed follow-up offer.`,
        invalidKeys: ["promotions"],
      };
    }

    const overlap = findOverlappingPricePromotionPair(promotions);
    if (overlap) {
      const [first, second] = overlap;
      return {
        ok: false,
        status: 400,
        error:
          `Only one automatic price promotion can be active for ${String(first.linkedService).trim()} at a time. ` +
          `"${first.name}" overlaps with "${second.name}". Adjust the dates or disable automatic send on one promotion.`,
        invalidKeys: ["promotions"],
      };
    }
  }

  return { ok: true, updates, keys };
}

router.post("/automated-follow-up/translations", async (req, res) => {
  try {
    if (Array.isArray(req.body?.messages)) {
      const messages = req.body.messages.map((message) =>
        typeof message === "string" ? message.trim() : ""
      );
      if (
        messages.length < 1 ||
        messages.length > followUpTranslationService.MAX_TRANSLATION_BATCH ||
        messages.some((message) => !message || message.length > 1000)
      ) {
        return res.status(400).json({
          error: `Send 1 to ${followUpTranslationService.MAX_TRANSLATION_BATCH} follow-up messages, each under 1,000 characters.`,
        });
      }
      const translations = await followUpTranslationService.translateFollowUps(messages);
      return res.json({ translations });
    }

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message || message.length > 1000) {
      return res.status(400).json({
        error: "Enter a follow-up message under 1,000 characters first.",
      });
    }

    const translations = await followUpTranslationService.translateFollowUp(message);
    res.json({ translations });
  } catch (err) {
    console.error("Failed to translate automated follow-up:", err);
    res.status(502).json({
      error: "The translations could not be generated. Please try again.",
    });
  }
});

router.get("/comment-automation/status", async (req, res) => {
  try {
    const requestBaseUrl = `${req.protocol}://${req.get("host")}`;
    const status = await commentAutomationReadiness.getCommentAutomationReadiness({
      requestBaseUrl,
    });
    res.json(status);
  } catch (err) {
    console.error("Failed to load comment automation channel status:", err);
    res.status(500).json({
      error: "Something went wrong loading comment automation channel status.",
    });
  }
});

router.get("/lead-distribution/status", async (req, res) => {
  try {
    const [accounts, unassigned] = await Promise.all([
      usersRepo.listActiveSalesUsers(),
      leadDistributionRepo.getUnassignedCounts(),
    ]);
    const config = configRepo.getConfig();
    const configuredBranches = (config.branches || [])
      .map((branch) => String(branch?.name || "").trim())
      .filter(Boolean);
    const leadScoringEnabled = config.leadScoring?.enabled === true;
    const telegramSummaryEnabled = telegramAlertService.isTelegramEnabled();

    res.json({
      strategy: "round_robin",
      configuredBranches,
      ...unassigned,
      aiBranchRecording: {
        enabled: leadScoringEnabled || telegramSummaryEnabled,
        leadScoringEnabled,
        telegramSummaryEnabled,
      },
      accounts: accounts.map((user) => ({
        id: user.id,
        username: user.username,
        displayName: user.display_name || user.username,
        branchName: user.branch_name || null,
      })),
    });
  } catch (err) {
    console.error("Failed to load lead distribution status:", err);
    res.status(500).json({ error: "Something went wrong loading lead distribution." });
  }
});

router.post("/lead-distribution/recover-unassigned", async (req, res) => {
  try {
    const config = configRepo.getConfig();
    if (config.leadDistribution?.enabled !== true) {
      return res.status(409).json({
        error: "Enable Automatic Lead Distribution before recovering unassigned leads.",
      });
    }

    const accounts = await usersRepo.listActiveSalesUsers();
    if (accounts.length === 0) {
      return res.status(409).json({
        error: "Add or reactivate an eligible Sales account before recovering unassigned leads.",
      });
    }

    const outcome = await leadDistributionRepo.recoverUnassignedOpenLeads(100);
    res.json(outcome);
  } catch (err) {
    console.error("Failed to recover unassigned leads:", err);
    res.status(500).json({ error: "Something went wrong recovering unassigned leads." });
  }
});

async function saveUploadedImage(
  req,
  res,
  {
    purpose = promoImagesRepo.IMAGE_PURPOSES.PUBLIC_CONFIG,
    privatePreview = false,
  } = {}
) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "An image file is required." });
    }

    const id = await promoImagesRepo.saveImage(
      req.file.mimetype,
      req.file.buffer.toString("base64"),
      { purpose }
    );

    if (privatePreview) {
      // Same-origin authenticated preview. Do not return a permanent public URL
      // for Before/After media because these images may identify a patient.
      return res.status(201).json({
        url: `/api/config/result-media/image/${id}`,
      });
    }

    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    return res.status(201).json({ url: `${baseUrl}/promo-images/${id}` });
  } catch (err) {
    console.error("Failed to upload config image:", err);
    return res.status(500).json({ error: "Something went wrong uploading this image." });
  }
}

router.post("/promotions/image", handleImageUpload, (req, res) =>
  saveUploadedImage(req, res)
);
router.post("/result-media/image", handleImageUpload, (req, res) =>
  saveUploadedImage(req, res, {
    purpose: promoImagesRepo.IMAGE_PURPOSES.RESULT_MEDIA,
    privatePreview: true,
  })
);
router.post("/automated-follow-up/image", handleImageUpload, (req, res) =>
  saveUploadedImage(req, res)
);

router.get("/result-media/image/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(404).send("Not found");
    }

    const image = await promoImagesRepo.getImage(id);
    if (
      !image ||
      image.purpose !== promoImagesRepo.IMAGE_PURPOSES.RESULT_MEDIA
    ) {
      return res.status(404).send("Not found");
    }

    res.set("Content-Type", image.mime_type);
    res.set("Cache-Control", "private, no-store");
    return res.send(Buffer.from(image.data, "base64"));
  } catch (err) {
    console.error("Failed to serve private result media:", err);
    return res.status(500).send("Something went wrong.");
  }
});

router.delete("/promotions/image/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid image id." });
    }

    await promoImagesRepo.deleteImage(id);
    res.status(204).end();
  } catch (err) {
    console.error("Failed to delete promo image:", err);
    res.status(500).json({ error: "Something went wrong deleting this image." });
  }
});

router.get("/", async (req, res) => {
  try {
    res.json(decorateConfig(configRepo.getConfig()));
  } catch (err) {
    console.error("Failed to load clinic config:", err);
    res.status(500).json({ error: "Something went wrong loading settings." });
  }
});

router.patch("/", async (req, res) => {
  try {
    const prepared = prepareConfigUpdatePayload(req.body || {}, configRepo.getConfig());
    if (!prepared.ok) {
      return res.status(prepared.status || 400).json({
        error: prepared.error,
        unknownKeys: prepared.unknownKeys || undefined,
        invalidKeys: prepared.invalidKeys || undefined,
      });
    }

    const updated = await configRepo.updateConfig(prepared.updates);
    res.json(decorateConfig(updated));
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) {
      console.error("Failed to update clinic config:", err);
    }
    res.status(status).json({
      error: err?.message || "Something went wrong saving settings.",
      code: err?.code || null,
    });
  }
});

module.exports = router;
module.exports.decorateConfig = decorateConfig;
module.exports.isCommentAutomationConfig = isCommentAutomationConfig;
module.exports.prepareCommentAutomationConfig = prepareCommentAutomationConfig;
module.exports.prepareConfigUpdatePayload = prepareConfigUpdatePayload;
module.exports.prepareLeadScoringConfig = prepareLeadScoringConfig;
module.exports.VALIDATORS = VALIDATORS;
