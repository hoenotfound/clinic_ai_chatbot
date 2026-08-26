const express = require("express");
const multer = require("multer");
const configRepo = require("../db/configRepo");
const promoImagesRepo = require("../db/promoImagesRepo");

const router = express.Router();

// Staff promo-graphic uploads from Settings > Promotions — kept in memory
// (never written to disk), then persisted to Postgres (see
// db/promoImagesRepo.js) and served back out at a public URL WhatsApp's
// Cloud API can fetch. Same limits as the Inbox's staff image upload
// (routes/conversations.js) — 16MB matches WhatsApp's own image size cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  },
});

// Wraps upload.single("image") so Multer errors (file too large, wrong
// mimetype) are turned into a JSON response instead of falling through to
// Express's default HTML error handler — see the identical pattern (and
// fuller explanation) in routes/conversations.js.
function handleImageUpload(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Image is too large. Please choose a file under 16MB." });
    }
    return res.status(400).json({ error: err.message || "Failed to upload image." });
  });
}

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

// POST /api/config/promotions/image — staff uploads a promo graphic directly
// (instead of pasting an already-hosted URL). Stored in Postgres and handed
// back as a public URL pointing at GET /promo-images/:id (see server.js) —
// the Settings page drops that URL straight into the promotion's imageUrl
// field, no separate hosting step needed.
router.post("/promotions/image", handleImageUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "An image file is required." });
    }

    const id = await promoImagesRepo.saveImage(req.file.mimetype, req.file.buffer.toString("base64"));

    // PUBLIC_BASE_URL lets you override this for unusual setups (custom
    // domain behind a CDN, etc.) — otherwise it's inferred from the request
    // itself, which works fine on Render/most hosts as long as `trust
    // proxy` is set (see server.js) so req.protocol reflects the original
    // https scheme rather than the proxy's internal http hop.
    const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.status(201).json({ url: `${baseUrl}/promo-images/${id}` });
  } catch (err) {
    console.error("Failed to upload promo image:", err);
    res.status(500).json({ error: "Something went wrong uploading this image." });
  }
});

// DELETE /api/config/promotions/image/:id — cleans up a promo image row
// once it's no longer referenced by any promotion (staff replaced it with a
// new upload, or hit "Remove"). See portal-frontend/src/pages/Settings.jsx
// ImageFieldEditor, which calls this right after a successful replace and
// right before clearing the field on remove. Best-effort from the client's
// point of view — a failed delete here just leaves an orphaned row rather
// than losing anything, so it's safe to fire without blocking the UI.
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
