const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const {
  getInitialConfig,
  hydrateBusinessConfig,
} = require("../config/industryProfiles");
const {
  createSeedIndustrySetup,
  lockIndustrySetup,
  normalizeIndustrySetup,
} = require("../config/industrySetup");
const industrySetupRepo = require("./industrySetupRepo");
const pipelineDefaultsRepo = require("./pipelineDefaultsRepo");
const promoImagesRepo = require("./promoImagesRepo");
const { DEFAULT_LEAD_DISTRIBUTION } = require("../utils/leadDistribution");
const realtimeEvents = require("../utils/realtimeEvents");

// Every top-level key the Settings page is allowed to read/write. Keep the
// historical clinicName key during the migration so existing UI/API clients
// continue to work. businessName is synchronized with it in updateConfig().
// Profile-owned businessType/terminology/conversion metadata stays outside this
// list: industry selection goes through the dedicated atomic Setup Status action.
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

// businessType remains intentionally unavailable through normal Settings PATCH.
// The dedicated profile selector replaces the complete industry profile and
// Pipeline together, and only while the deployment is still safe to re-profile.
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

function hydrateStoredConfig(storedConfig = {}) {
  const hydratedConfig = hydrateBusinessConfig(storedConfig);
  return {
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
  };
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
 * Loads DB-backed config into the shared live object. A fresh database is seeded
 * from the requested industry when one was explicitly provisioned. With no
 * industry environment variable, Aesthetic Clinic remains the default and the
 * untouched seed stays selectable from Setup Status until configuration begins.
 * Existing pre-profile databases remain clinic-compatible and fail closed for
 * profile changes because they do not carry selectable industrySetup metadata.
 */
async function loadConfig() {
  const result = await pool.query("SELECT data FROM clinic_config WHERE id = 1");

  if (result.rows.length === 0) {
    const initialConfig = getInitialConfig();
    const seededConfig = {
      ...initialConfig,
      leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
      industrySetup: createSeedIndustrySetup(),
    };
    await pool.query("INSERT INTO clinic_config (id, data) VALUES (1, $1)", [seededConfig]);
    Object.assign(clinicConfig, seededConfig);
    await pipelineDefaultsRepo.ensureIndustryPipelineDefaults(seededConfig);
    console.log(`Seeded clinic_config table from ${seededConfig.businessType} industry profile.`);
    return clinicConfig;
  }

  const storedConfig = result.rows[0].data || {};
  industrySetupRepo.replaceLiveConfig(hydrateStoredConfig(storedConfig));
  await pipelineDefaultsRepo.ensureIndustryPipelineDefaults(clinicConfig);
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
 *
 * Every config writer locks the clinic_config row and builds from the value it
 * reads after that lock is acquired. This serializes Settings with the atomic
 * industry selector, so a stale request can never overwrite a profile switch
 * that committed while it was waiting for the row lock.
 *
 * The first ordinary Settings save also locks a still-selectable default
 * industry seed. Once client-specific facts are being configured, switching the
 * entire industry profile would be destructive and must no longer be allowed.
 */
async function updateConfig(updates, database = pool) {
  const client = await database.connect();
  let inTransaction = false;
  let nextConfig;
  const changedKeys = [];

  try {
    await client.query("BEGIN");
    inTransaction = true;

    const result = await client.query(
      "SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE"
    );
    if (!result.rows?.length) {
      throw new Error("clinic_config row is missing.");
    }

    // Build from the locked database value, not the process-local cache. During
    // rolling deploys another instance may have committed a profile selection
    // immediately before this request acquired the row lock.
    nextConfig = hydrateStoredConfig(result.rows[0].data || {});

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

    const changedPublicSetting = changedKeys.some((key) => CONFIG_KEYS.includes(key));
    const industrySetup = normalizeIndustrySetup(nextConfig.industrySetup);
    if (changedPublicSetting && industrySetup.selectable && !industrySetup.locked) {
      nextConfig.industrySetup = lockIndustrySetup(industrySetup, {
        source: "settings",
        reason: "settings_configured",
      });
      changedKeys.push("industrySetup");
    }

    await client.query(
      "UPDATE clinic_config SET data = $1, updated_at = now() WHERE id = 1",
      [nextConfig]
    );
    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Apply live settings only after Postgres accepts the save. Replace rather
  // than merge so a process whose cache was stale after another instance's
  // profile selection cannot retain keys from the previous industry profile.
  industrySetupRepo.replaceLiveConfig(nextConfig);

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
  getConfig,
  getIndustrySetupStatus: industrySetupRepo.getIndustrySetupStatus,
  hydrateStoredConfig,
  loadConfig,
  pruneOrphanedPromoImages,
  selectIndustryProfile: industrySetupRepo.selectIndustryProfile,
  updateConfig,
};
