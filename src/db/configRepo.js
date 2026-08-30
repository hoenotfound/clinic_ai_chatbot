const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const defaultConfig = require("../config/clinicConfig.default");
const promoImagesRepo = require("./promoImagesRepo");

// Every top-level key the Settings page is allowed to read/write. Kept as a
// single list shared by loadConfig/updateConfig so there's one place to
// touch if a new config section is ever added.
const CONFIG_KEYS = [
  "clinicName",
  "aiAssistantName",
  "branches",
  "hours",
  "contact",
  "introMessage",
  "automatedFollowUp",
  "leadScoring",
  "promotions",
  "services",
  "serviceAliases",
  "faqs",
  "closingPlaybook",
  "tone",
  "messagingStyle",
  "sop",
  "escalation",
  "guardrails",
];

// Internal runtime state that must survive restarts but must not become a
// staff-editable Settings API field. Telegram conversation summaries keep a
// separate activation boundary from the Auto AI Lead Temperature toggle.
const INTERNAL_CONFIG_KEYS = ["telegramConversationSummary"];

/**
 * Pulls the numeric row id out of one of our own hosted promo-image URLs
 * (e.g. ".../promo-images/42" -> 42). Returns null for anything else — a
 * staff-pasted external URL, an empty imageUrl, etc. — since those have no
 * corresponding row to protect from pruning.
 */
function extractPromoImageId(url) {
  if (!url) return null;
  const match = String(url).match(/\/promo-images\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * Deletes any promo_images row that isn't referenced by the current
 * config's promotions and is older than the grace period — cleans up
 * uploads that were replaced/removed outside the normal flow (see
 * promoImagesRepo.pruneUnreferenced for the full explanation). Errors are
 * logged, not thrown: this is best-effort housekeeping and should never be
 * allowed to break a config load or save.
 */
async function pruneOrphanedPromoImages() {
  try {
    const promotionIds = (clinicConfig.promotions || [])
      .map((p) => extractPromoImageId(p.imageUrl))
      .filter((id) => id !== null);
    const followUpImageId = extractPromoImageId(
      clinicConfig.automatedFollowUp?.imageUrl
    );
    const referencedIds = followUpImageId === null
      ? promotionIds
      : [...promotionIds, followUpImageId];
    await promoImagesRepo.pruneUnreferenced(referencedIds);
  } catch (err) {
    console.error("Failed to prune orphaned promo images:", err);
  }
}

/**
 * Loads the DB-backed config into the shared `clinicConfig` object,
 * mutating its properties in place (not replacing the object — see
 * config/clinicConfig.js for why that matters). Called once at server
 * startup, after initSchema(). On a brand-new database the clinic_config
 * table is empty, so this seeds it from the hardcoded defaults first —
 * same "auto-bootstrap on first run" pattern as bootstrapAdminUser().
 */
async function loadConfig() {
  const result = await pool.query("SELECT data FROM clinic_config WHERE id = 1");

  if (result.rows.length === 0) {
    await pool.query("INSERT INTO clinic_config (id, data) VALUES (1, $1)", [defaultConfig]);
    Object.assign(clinicConfig, defaultConfig);
    console.log("Seeded clinic_config table from config/clinicConfig.default.js.");
    return clinicConfig;
  }

  const storedConfig = result.rows[0].data || {};
  Object.assign(clinicConfig, {
    ...defaultConfig,
    ...storedConfig,
    automatedFollowUp: {
      ...defaultConfig.automatedFollowUp,
      ...(storedConfig.automatedFollowUp || {}),
    },
    leadScoring: {
      ...defaultConfig.leadScoring,
      ...(storedConfig.leadScoring || {}),
    },
  });
  return clinicConfig;
}

/** Returns the live, in-memory config object (see config/clinicConfig.js). */
function getConfig() {
  return clinicConfig;
}

/**
 * Applies a partial update — only recognized top-level keys present in
 * `updates` are touched, everything else in the current config is left
 * alone. Updates both the in-memory object (so the AI picks it up on the
 * very next message, no restart) and the DB row (so it survives one).
 */
async function updateConfig(updates) {
  const nextConfig = { ...clinicConfig };
  for (const key of [...CONFIG_KEYS, ...INTERNAL_CONFIG_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      nextConfig[key] = updates[key];
    }
  }

  await pool.query("UPDATE clinic_config SET data = $1, updated_at = now() WHERE id = 1", [
    nextConfig,
  ]);

  // Apply live settings only after Postgres accepts the save. This matters
  // most for automations: a failed browser save must never briefly enable a
  // tool that will not survive the next restart.
  Object.assign(clinicConfig, nextConfig);

  // If this update touched promotions, some image(s) may have just been
  // dropped from the config (staff removed a promotion entirely, or
  // replaced/cleared its image via an edit that bypassed the immediate
  // DELETE call in Settings.jsx). Reconcile now rather than waiting for the
  // next timed sweep.
  if (
    Object.prototype.hasOwnProperty.call(updates, "promotions") ||
    Object.prototype.hasOwnProperty.call(updates, "automatedFollowUp")
  ) {
    await pruneOrphanedPromoImages();
  }

  return clinicConfig;
}

module.exports = { CONFIG_KEYS, loadConfig, getConfig, updateConfig, pruneOrphanedPromoImages };
