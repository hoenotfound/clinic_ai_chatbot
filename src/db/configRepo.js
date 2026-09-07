const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const {
  getInitialConfig,
  hydrateBusinessConfig,
} = require("../config/industryProfiles");
const promoImagesRepo = require("./promoImagesRepo");
const { DEFAULT_LEAD_DISTRIBUTION } = require("../utils/leadDistribution");
const realtimeEvents = require("../utils/realtimeEvents");

// Every top-level key the Settings page is allowed to read/write. Keep the
// historical clinicName key during the migration so existing UI/API clients
// continue to work. businessName is synchronized with it in updateConfig().
// Profile-owned businessType/terminology/conversion metadata deliberately stays
// outside this list until there is a dedicated atomic industry-change action.
const CONFIG_KEYS = [
  "clinicName",
  "businessName",
  "businessDescription",
  "aiAssistantName",
  "branches",
  "hours",
  "contact",
  "introMessage",
  "automatedFollowUp",
  "leadScoring",
  "leadDistribution",
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

// businessType is intentionally not a normal mutable Settings field yet.
// Changing industry should eventually go through a dedicated onboarding/profile
// action that can safely replace all related defaults together, not just flip a
// label while leaving clinic-specific content behind.
const INTERNAL_CONFIG_KEYS = ["telegramConversationSummary"];

// server.js keeps its old 30-minute housekeeping callback for compatibility,
// but this guard makes that callback a no-op unless a full day has elapsed.
// Config changes force an immediate cleanup while Postgres is already awake.
const PROMO_IMAGE_BACKSTOP_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPromoImageBackstopPruneAt = 0;

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
 *
 * Background callers are throttled so they cannot keep Neon awake. A settings
 * change passes force=true because the database is already active and cleanup
 * should happen immediately after a promotion/follow-up image is replaced.
 */
async function pruneOrphanedPromoImages(force = false, now = Date.now()) {
  if (
    !force &&
    lastPromoImageBackstopPruneAt > 0 &&
    now - lastPromoImageBackstopPruneAt < PROMO_IMAGE_BACKSTOP_PRUNE_INTERVAL_MS
  ) {
    return false;
  }

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
    lastPromoImageBackstopPruneAt = now;
    return true;
  } catch (err) {
    console.error("Failed to prune orphaned promo images:", err);
    return false;
  }
}

/**
 * Loads DB-backed config into the shared live object. A fresh database is now
 * seeded from the selected industry profile rather than always copying the
 * Beleco/aesthetic defaults. Existing pre-profile databases are recognized as
 * clinic deployments and hydrated with the aesthetic profile for backward
 * compatibility.
 */
async function loadConfig() {
  const result = await pool.query("SELECT data FROM clinic_config WHERE id = 1");

  if (result.rows.length === 0) {
    const initialConfig = getInitialConfig();
    const seededConfig = {
      ...initialConfig,
      leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
    };
    await pool.query("INSERT INTO clinic_config (id, data) VALUES (1, $1)", [seededConfig]);
    Object.assign(clinicConfig, seededConfig);
    console.log(`Seeded clinic_config table from ${seededConfig.businessType} industry profile.`);
    return clinicConfig;
  }

  const storedConfig = result.rows[0].data || {};
  const hydratedConfig = hydrateBusinessConfig(storedConfig);
  Object.assign(clinicConfig, {
    ...hydratedConfig,
    automatedFollowUp: {
      ...hydratedConfig.automatedFollowUp,
      ...(storedConfig.automatedFollowUp || {}),
    },
    leadScoring: {
      ...hydratedConfig.leadScoring,
      ...(storedConfig.leadScoring || {}),
    },
    leadDistribution: {
      ...DEFAULT_LEAD_DISTRIBUTION,
      ...(storedConfig.leadDistribution || {}),
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
 * `updates` are touched, everything else in the current config is left alone.
 * During the migration, clinicName and businessName are kept synchronized so
 * old modules/UI and new industry-neutral code cannot drift to different names.
 */
async function updateConfig(updates) {
  const nextConfig = { ...clinicConfig };
  const changedKeys = [];
  for (const key of [...CONFIG_KEYS, ...INTERNAL_CONFIG_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      nextConfig[key] = updates[key];
      changedKeys.push(key);
    }
  }

  const hasBusinessName = Object.prototype.hasOwnProperty.call(updates, "businessName");
  const hasClinicName = Object.prototype.hasOwnProperty.call(updates, "clinicName");
  if (hasBusinessName) {
    nextConfig.businessName = updates.businessName;
    nextConfig.clinicName = updates.businessName;
    if (!changedKeys.includes("clinicName")) changedKeys.push("clinicName");
  } else if (hasClinicName) {
    nextConfig.clinicName = updates.clinicName;
    nextConfig.businessName = updates.clinicName;
    if (!changedKeys.includes("businessName")) changedKeys.push("businessName");
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
  // next timed sweep. This is forced because the DB is already awake for the
  // config save and staff expects the change to take effect immediately.
  if (
    Object.prototype.hasOwnProperty.call(updates, "promotions") ||
    Object.prototype.hasOwnProperty.call(updates, "automatedFollowUp")
  ) {
    await pruneOrphanedPromoImages(true);
  }

  if (changedKeys.length > 0) {
    realtimeEvents.publish("config_changed", { keys: changedKeys });
  }

  return clinicConfig;
}

module.exports = {
  CONFIG_KEYS,
  PROMO_IMAGE_BACKSTOP_PRUNE_INTERVAL_MS,
  loadConfig,
  getConfig,
  updateConfig,
  pruneOrphanedPromoImages,
};
