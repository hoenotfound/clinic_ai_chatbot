const express = require("express");
const configRepo = require("../db/configRepo");

const router = express.Router();

// Shape checks for each top-level config key — deliberately loose (this
// isn't a full schema validator), just enough to stop an obviously wrong
// payload (wrong type, missing required sub-field) from reaching the AI's
// system prompt builder and breaking every reply. See utils/systemPrompt.js
// for how each of these is read back out.
const VALIDATORS = {
  clinicName: isNonEmptyString,
  aiAssistantName: isNonEmptyString,
  introMessage: isNonEmptyString,
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

// GET /api/config — full clinic config, used to populate the Settings page.
router.get("/", async (req, res) => {
  try {
    res.json(configRepo.getConfig());
  } catch (err) {
    console.error("Failed to load clinic config:", err);
    res.status(500).json({ error: "Something went wrong loading settings." });
  }
});

// PATCH /api/config — partial update. The Settings page saves one section
// (tab) at a time, so the body is usually just one or two keys — anything
// not included is left untouched. Takes effect immediately (see
// db/configRepo.js) since the AI reads this same in-memory object fresh on
// every message, no restart required.
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

    const invalidKeys = keys.filter((k) => !VALIDATORS[k](updates[k]));
    if (invalidKeys.length > 0) {
      return res.status(400).json({ error: `Invalid value for: ${invalidKeys.join(", ")}` });
    }

    const updated = await configRepo.updateConfig(updates);
    res.json(updated);
  } catch (err) {
    console.error("Failed to update clinic config:", err);
    res.status(500).json({ error: "Something went wrong saving settings." });
  }
});

module.exports = router;
