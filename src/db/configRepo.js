const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const {
  hydrateBusinessConfig,
} = require("../config/industryProfiles");
const {
  getInitialOnboardingConfig,
} = require("../config/onboardingIndustryProfiles");
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

const CONFIG_KEYS = [
  "clinicName",
  "businessName",
  "businessDescription",
  "aiAssistantName",
  "branches",
  "serviceAreas",
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

const INTERNAL_CONFIG_KEYS = ["telegramConversationSummary"];
const PROMO_IMAGE_BACKSTOP_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPromoImageBackstopPruneAt = 0;

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

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

async function loadConfig() {
  const result = await pool.query("SELECT data FROM clinic_config WHERE id = 1");

  if (result.rows.length === 0) {
    const initialConfig = getInitialOnboardingConfig();
    const seededConfig = {
      ...initialConfig,
      leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
      industrySetup: createSeedIndustrySetup(),
    };
    await pool.query("INSERT INTO clinic_config (id, data) VALUES (1, $1)", [seededConfig]);
    industrySetupRepo.replaceLiveConfig(seededConfig);
    await pipelineDefaultsRepo.ensureIndustryPipelineDefaults(seededConfig);
    console.log(`Seeded clinic_config table from ${seededConfig.businessType} onboarding profile.`);
    return clinicConfig;
  }

  const storedConfig = result.rows[0].data || {};
  industrySetupRepo.replaceLiveConfig(hydrateStoredConfig(storedConfig));
  await pipelineDefaultsRepo.ensureIndustryPipelineDefaults(clinicConfig);
  return clinicConfig;
}

function getConfig() {
  return clinicConfig;
}

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
      const customerData = await industrySetupRepo.loadCustomerDataState(client);
      if (customerData.hasCustomerData) {
        nextConfig.industrySetup = lockIndustrySetup(industrySetup, {
          source: "customer_data",
          reason: "customer_data_exists",
        });
        changedKeys.push("industrySetup");
      } else {
        const stageResult = await client.query(
          `SELECT id, name, sort_order, color, stage_type, system_key
           FROM pipeline_stages
           ORDER BY sort_order ASC, id ASC`
        );
        const setupStatus = industrySetupRepo.buildIndustrySetupStatus(nextConfig, {
          customerData,
          stages: stageResult.rows || [],
        });

        if (setupStatus.selection.lockReason === "pipeline_customized") {
          nextConfig.industrySetup = lockIndustrySetup(industrySetup, {
            source: "pipeline",
            reason: "pipeline_customized",
          });
          changedKeys.push("industrySetup");
        } else {
          throw conflict(
            "INDUSTRY_PROFILE_NOT_CONFIRMED",
            "Confirm this client's Business Profile in Setup Status before changing client Settings."
          );
        }
      }
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

  industrySetupRepo.replaceLiveConfig(nextConfig);

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

async function withPipelineCustomizationLock(
  work,
  {
    actor = null,
    database = pool,
    now = new Date(),
  } = {}
) {
  if (typeof work !== "function") {
    throw new TypeError("Pipeline customization work must be a function.");
  }

  const client = await database.connect();
  let inTransaction = false;
  let nextStoredConfig = null;
  let nextIndustrySetup = null;
  let result;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    const configResult = await client.query(
      "SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE"
    );
    if (!configResult.rows?.length) {
      throw new Error("clinic_config row is missing.");
    }

    const storedConfig = configResult.rows[0].data || {};
    result = await work();

    if (result !== null && result !== undefined) {
      const setup = normalizeIndustrySetup(storedConfig.industrySetup);
      if (setup.selectable && !setup.locked) {
        nextIndustrySetup = lockIndustrySetup(setup, {
          source: "pipeline",
          reason: "pipeline_customized",
          actor,
          now,
        });
        nextStoredConfig = {
          ...storedConfig,
          industrySetup: nextIndustrySetup,
        };
        await client.query(
          "UPDATE clinic_config SET data = $1, updated_at = now() WHERE id = 1",
          [nextStoredConfig]
        );
      }
    }

    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (nextIndustrySetup) {
    clinicConfig.industrySetup = nextIndustrySetup;
    realtimeEvents.publish("config_changed", { keys: ["industrySetup"] });
  }

  return result;
}

function selectIndustryProfile(businessType, {
  actor = null,
  database = pool,
  now = new Date(),
} = {}) {
  return industrySetupRepo.selectIndustryProfile(
    businessType,
    database,
    now,
    actor
  );
}

module.exports = {
  CONFIG_KEYS,
  PROMO_IMAGE_BACKSTOP_PRUNE_INTERVAL_MS,
  getConfig,
  getIndustrySetupStatus: industrySetupRepo.getIndustrySetupStatus,
  hydrateStoredConfig,
  loadConfig,
  pruneOrphanedPromoImages,
  selectIndustryProfile,
  updateConfig,
  withPipelineCustomizationLock,
};
