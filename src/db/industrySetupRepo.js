const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const {
  DEFAULT_BUSINESS_TYPE,
  getIndustryProfile,
  normalizeBusinessType,
} = require("../config/industryProfiles");
const {
  getBusinessProfileOptions,
  lockIndustrySetup,
  normalizeIndustrySetup,
} = require("../config/industrySetup");
const { getPipelineProfile } = require("../config/pipelineProfiles");
const { getConversionProfile } = require("../config/conversionProfiles");
const {
  getLeadTemperatureRuleProfile,
} = require("../config/leadTemperatureRuleProfiles");
const {
  getAnalyticsPipelineProfile,
} = require("./analyticsPipelineProfile");
const {
  setAnalyticsProfileForStages,
  stagesExactlyMatch,
} = require("./pipelineDefaultsRepo");
const { DEFAULT_LEAD_DISTRIBUTION } = require("../utils/leadDistribution");
const realtimeEvents = require("../utils/realtimeEvents");

const PRESERVED_INTERNAL_CONFIG_KEYS = ["telegramConversationSummary"];

function conflict(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function replaceLiveConfig(nextConfig) {
  for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
  Object.assign(clinicConfig, nextConfig);
}

function buildSelectedConfig(storedConfig, businessType, now = new Date()) {
  const profile = getIndustryProfile(businessType);
  const nextConfig = {
    ...profile,
    leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
    industrySetup: lockIndustrySetup(storedConfig?.industrySetup, {
      source: "setup_status",
      reason: "profile_confirmed",
      now,
    }),
  };

  for (const key of PRESERVED_INTERNAL_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(storedConfig || {}, key)) {
      nextConfig[key] = storedConfig[key];
    }
  }

  return nextConfig;
}

async function loadCustomerDataState(database = pool) {
  const result = await database.query(`
    SELECT
      EXISTS (SELECT 1 FROM contacts LIMIT 1) AS has_contacts,
      EXISTS (SELECT 1 FROM messages LIMIT 1) AS has_messages,
      EXISTS (SELECT 1 FROM leads LIMIT 1) AS has_leads
  `);
  const row = result.rows?.[0] || {};
  return {
    hasContacts: row.has_contacts === true,
    hasMessages: row.has_messages === true,
    hasLeads: row.has_leads === true,
    hasCustomerData:
      row.has_contacts === true || row.has_messages === true || row.has_leads === true,
  };
}

async function getIndustrySetupStatus(database = pool) {
  const [customerData, stageResult] = await Promise.all([
    loadCustomerDataState(database),
    database.query(
      `SELECT id, name, sort_order, color, stage_type, system_key
       FROM pipeline_stages
       ORDER BY sort_order ASC, id ASC`
    ),
  ]);

  const config = clinicConfig;
  const setup = normalizeIndustrySetup(config.industrySetup);
  const pipelineProfile = getPipelineProfile(config);
  const stages = stageResult.rows || [];
  const pipelineMatchesDefault = stagesExactlyMatch(stages, pipelineProfile.defaultStages);
  const effectiveAnalytics = getAnalyticsPipelineProfile(config, {
    availableSystemKeys: stages.map((stage) => stage.system_key),
  });
  const conversion = getConversionProfile(config);
  const temperatureRules = getLeadTemperatureRuleProfile(config);

  let lockReason = setup.lockReason;
  if (customerData.hasCustomerData) lockReason = "customer_data_exists";
  else if (!pipelineMatchesDefault) lockReason = "pipeline_customized";
  else if (setup.locked && !lockReason) lockReason = "profile_locked";

  const selectable =
    setup.selectable === true &&
    setup.locked !== true &&
    !customerData.hasCustomerData &&
    pipelineMatchesDefault;

  const currentOption = getBusinessProfileOptions().find(
    (option) => option.value === config.businessType
  );

  return {
    businessType: config.businessType || DEFAULT_BUSINESS_TYPE,
    label: currentOption?.label || config.businessType || "Aesthetic Clinic",
    defaultBusinessType: DEFAULT_BUSINESS_TYPE,
    options: getBusinessProfileOptions(),
    selection: {
      selectable,
      locked: !selectable,
      source: setup.source,
      selectedAt: setup.selectedAt,
      lockReason,
      hasCustomerData: customerData.hasCustomerData,
    },
    alignment: {
      pipeline: {
        businessType: pipelineProfile.businessType,
        mode: pipelineMatchesDefault ? "profile_default" : "customized",
      },
      conversion: {
        businessType: config.businessType || DEFAULT_BUSINESS_TYPE,
        mode: conversion.mode,
        enabled: conversion.enabled === true,
      },
      leadTemperature: {
        businessType: temperatureRules.id,
        mode: temperatureRules.mode,
      },
      analytics: {
        businessType: effectiveAnalytics.businessType,
        fallback: effectiveAnalytics.businessType !== pipelineProfile.businessType,
      },
    },
  };
}

async function insertStages(client, stages) {
  for (const stage of stages) {
    await client.query(
      `INSERT INTO pipeline_stages (name, sort_order, color, stage_type, system_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [stage.name, stage.sortOrder, stage.color, stage.stageType, stage.systemKey]
    );
  }
}

async function selectIndustryProfile(requestedType, database = pool, now = new Date()) {
  const businessType = normalizeBusinessType(requestedType);
  if (!businessType) {
    const error = new Error(`Unsupported business type "${requestedType || ""}".`);
    error.code = "UNSUPPORTED_BUSINESS_TYPE";
    error.status = 400;
    throw error;
  }

  const client = await database.connect();
  let inTransaction = false;
  let nextConfig;
  let nextPipelineProfile;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    const configResult = await client.query(
      "SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE"
    );
    if (!configResult.rows?.length) {
      throw conflict(
        "INDUSTRY_PROFILE_NOT_READY",
        "Business profile setup is not ready yet. Reload the service and try again."
      );
    }

    // Block customer writes while the zero-data guard and profile replacement
    // happen. The lock order follows the customer-message flow, then Pipeline,
    // to avoid exposing a partially switched industry to a concurrent request.
    await client.query("LOCK TABLE contacts IN SHARE ROW EXCLUSIVE MODE");
    await client.query("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE");
    await client.query("LOCK TABLE leads IN SHARE ROW EXCLUSIVE MODE");
    await client.query("LOCK TABLE pipeline_stages IN ACCESS EXCLUSIVE MODE");

    const storedConfig = configResult.rows[0].data || {};
    const setup = normalizeIndustrySetup(storedConfig.industrySetup);
    if (setup.selectable !== true || setup.locked === true) {
      throw conflict(
        "INDUSTRY_PROFILE_LOCKED",
        "This deployment's business profile is already locked and cannot be changed from Setup Status."
      );
    }

    const customerDataResult = await client.query(`
      SELECT
        EXISTS (SELECT 1 FROM contacts LIMIT 1) AS has_contacts,
        EXISTS (SELECT 1 FROM messages LIMIT 1) AS has_messages,
        EXISTS (SELECT 1 FROM leads LIMIT 1) AS has_leads
    `);
    const customerData = customerDataResult.rows?.[0] || {};
    if (
      customerData.has_contacts === true ||
      customerData.has_messages === true ||
      customerData.has_leads === true
    ) {
      throw conflict(
        "INDUSTRY_PROFILE_HAS_DATA",
        "This deployment already has customer data, so its business profile can no longer be changed."
      );
    }

    const stageResult = await client.query(
      `SELECT id, name, sort_order, color, stage_type, system_key
       FROM pipeline_stages
       ORDER BY sort_order ASC, id ASC`
    );
    const currentPipelineProfile = getPipelineProfile(storedConfig);
    if (!stagesExactlyMatch(stageResult.rows || [], currentPipelineProfile.defaultStages)) {
      throw conflict(
        "INDUSTRY_PROFILE_PIPELINE_CUSTOMIZED",
        "The Pipeline has already been customized, so the business profile can no longer be changed."
      );
    }

    nextConfig = buildSelectedConfig(storedConfig, businessType, now);
    nextPipelineProfile = getPipelineProfile(nextConfig);

    await client.query(
      "UPDATE clinic_config SET data = $1, updated_at = now() WHERE id = 1",
      [nextConfig]
    );
    await client.query("DELETE FROM pipeline_stages");
    await insertStages(client, nextPipelineProfile.defaultStages);

    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  replaceLiveConfig(nextConfig);
  setAnalyticsProfileForStages(nextPipelineProfile, nextPipelineProfile.defaultStages);
  realtimeEvents.publish("config_changed", {
    keys: ["businessType", "businessName", "terminology", "conversion", "industrySetup"],
  });
  realtimeEvents.publish("pipeline_changed", {
    reason: "industry_profile_selected",
    businessType,
  });

  return getIndustrySetupStatus(database);
}

module.exports = {
  buildSelectedConfig,
  getIndustrySetupStatus,
  loadCustomerDataState,
  replaceLiveConfig,
  selectIndustryProfile,
};
