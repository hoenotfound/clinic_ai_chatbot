const express = require("express");
const multer = require("multer");
const configRepo = require("../db/configRepo");
const promoImagesRepo = require("../db/promoImagesRepo");
const usersRepo = require("../db/usersRepo");
const leadDistributionRepo = require("../db/leadDistributionRepo");
const followUpTranslationService = require("../services/followUpTranslationService");
const telegramAlertService = require("../services/telegramAlertService");
const { normalizeIndustrySetup } = require("../config/industrySetup");
const { evaluateClientSetup } = require("../services/clientSetupService");
const { normalizeLeadDistributionConfig } = require("../utils/leadDistribution");

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
    v.every((p) => isPlainObject(p) && isNonEmptyString(p.name) && isString(p.imageUrl) && isString(p.caption)),
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

function isAutomatedFollowUpConfig(value) {
  return (
    isPlainObject(value) &&
    typeof value.enabled === "boolean" &&
    Number.isInteger(value.delayMinutes) &&
    value.delayMinutes >= 5 &&
    value.delayMinutes <= 23 * 60 &&
    ["all", "staff"].includes(value.triggerMode) &&
    isNonEmptyString(value.message) &&
    value.message.length <= 1000 &&
    isFollowUpTranslations(value.translations) &&
    isString(value.imageUrl) &&
    (value.activatedAt === null || !Number.isNaN(Date.parse(value.activatedAt)))
  );
}

function isFollowUpTranslations(value) {
  return (
    isPlainObject(value) &&
    ["en", "ms", "zh"].every(
      (key) => isNonEmptyString(value[key]) && value[key].trim().length <= 1000
    )
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

function prepareAutomatedFollowUpConfig(requested, current) {
  if (!isPlainObject(requested)) return null;

  const enabled = requested.enabled;
  const delayMinutes = Number(requested.delayMinutes);
  const triggerMode = requested.triggerMode;
  const message = typeof requested.message === "string" ? requested.message.trim() : "";
  const translations = prepareFollowUpTranslations(requested.translations, message);
  const imageUrl = typeof requested.imageUrl === "string" ? requested.imageUrl.trim() : "";

  if (
    typeof enabled !== "boolean" ||
    !Number.isInteger(delayMinutes) ||
    delayMinutes < 5 ||
    delayMinutes > 23 * 60 ||
    !["all", "staff"].includes(triggerMode) ||
    !message ||
    message.length > 1000 ||
    !isFollowUpTranslations(translations)
  ) {
    return null;
  }

  const continuingCurrentActivation =
    enabled &&
    current?.enabled === true &&
    typeof current.activatedAt === "string" &&
    !Number.isNaN(Date.parse(current.activatedAt));

  return {
    enabled,
    delayMinutes,
    triggerMode,
    message,
    translations,
    imageUrl,
    activatedAt: enabled
      ? continuingCurrentActivation
        ? current.activatedAt
        : new Date().toISOString()
      : null,
  };
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

router.post("/automated-follow-up/translations", async (req, res) => {
  try {
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

async function saveUploadedImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "An image file is required." });
    }

    const id = await promoImagesRepo.saveImage(req.file.mimetype, req.file.buffer.toString("base64"));
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.status(201).json({ url: `${baseUrl}/promo-images/${id}` });
  } catch (err) {
    console.error("Failed to upload config image:", err);
    res.status(500).json({ error: "Something went wrong uploading this image." });
  }
}

router.post("/promotions/image", handleImageUpload, saveUploadedImage);
router.post("/automated-follow-up/image", handleImageUpload, saveUploadedImage);

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
    const updates = req.body || {};
    const keys = Object.keys(updates);

    if (keys.length === 0) {
      return res.status(400).json({ error: "No settings provided." });
    }

    const unknownKeys = keys.filter((k) => !VALIDATORS[k]);
    if (unknownKeys.length > 0) {
      return res.status(400).json({ error: `Unknown setting(s): ${unknownKeys.join(", ")}` });
    }

    if (Object.prototype.hasOwnProperty.call(updates, "automatedFollowUp")) {
      const prepared = prepareAutomatedFollowUpConfig(
        updates.automatedFollowUp,
        configRepo.getConfig().automatedFollowUp
      );
      if (!prepared) {
        return res.status(400).json({
          error: "Invalid automated follow-up settings. Use a delay between 5 minutes and 23 hours.",
        });
      }
      updates.automatedFollowUp = prepared;
    }

    if (Object.prototype.hasOwnProperty.call(updates, "leadScoring")) {
      const prepared = prepareLeadScoringConfig(
        updates.leadScoring,
        configRepo.getConfig().leadScoring
      );
      if (!prepared) {
        return res.status(400).json({
          error: "Invalid lead scoring settings. Check the inactivity, duration, and message limits.",
        });
      }
      updates.leadScoring = prepared;
    }

    if (Object.prototype.hasOwnProperty.call(updates, "leadDistribution")) {
      const prepared = normalizeLeadDistributionConfig(updates.leadDistribution);
      if (!prepared) {
        return res.status(400).json({
          error: "Invalid lead distribution settings. Round robin is the supported distribution method.",
        });
      }
      updates.leadDistribution = prepared;
    }

    const invalidKeys = keys.filter((k) => !VALIDATORS[k](updates[k]));
    if (invalidKeys.length > 0) {
      return res.status(400).json({ error: `Invalid value for: ${invalidKeys.join(", ")}` });
    }

    const updated = await configRepo.updateConfig(updates);
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
