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

function normalizeCustomerDataRow(row = {}) {
  return {
    hasContacts: row.has_contacts === true,
    hasMessages: row.has_messages === true,
    hasLeads: row.has_leads === true,
    hasCustomerData:
      row.has_contacts === true || row.has_messages === true || row.has_leads === true,
  };
}

async function queryCustomerDataState(queryable) {
  const result = await queryable.query(`
    SELECT
      EXISTS (SELECT 1 FROM contacts LIMIT 1) AS has_contacts,
      EXISTS (SELECT 1 FROM messages LIMIT 1) AS has_messages,
      EXISTS (SELECT 1 FROM leads LIMIT 1) AS has_leads
  `);
  return normalizeCustomerDataRow(result.rows?.[0] || {});
}

async function loadCustomerDataState(database = pool) {
  return queryCustomerDataState(database);
}

function profileStageRows(profile) {
  return profile.defaultStages.map((stage, index) => ({
    id: index + 1,
    name: stage.name,
    sort_order: stage.sortOrder,
    color: stage.color,
    stage_type: stage.stageType,
    system_key: stage.systemKey,
  }));
}

function buildIndustrySetupStatus(config, {
  customerData = normalizeCustomerDataRow(),
  stages = [],
} = {}) {
  const setup = normalizeIndustrySetup(config.industrySetup);
  const pipelineProfile = getPipelineProfile(config);
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

async function getIndustrySetupStatus(database = pool) {
  const [customerData, stageResult] = await Promise.all([
    loadCustomerDataState(database),
    database.query(
      `SELECT id, name, sort_order, color, stage_type, system_key
       FROM pipeline_stages
       ORDER BY sort_order ASC, id ASC`
    ),
  ]);

  return buildIndustrySetupStatus(clinicConfig, {
    customerData,
    stages: stageResult.rows || [],
  });
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

async function loadStageRows(queryable) {
  const result = await queryable.query(
    `SELECT id, name, sort_order, color, stage_type, system_key
     FROM pipeline_stages
     ORDER BY sort_order ASC, id ASC`
  );
  return result.rows || [];
}

function assertNoCustomerData(customerData) {
  if (!customerData.hasCustomerData) return;
  throw conflict(
    "INDUSTRY_PROFILE_HAS_DATA",
    "This deployment already has customer data, so its business profile can no longer be changed."
  );
}

function assertDefaultPipeline(stages, profile) {
  if (stagesExactlyMatch(stages, profile.defaultStages)) return;
  throw conflict(
    "INDUSTRY_PROFILE_PIPELINE_CUSTOMIZED",
    "The Pipeline has already been customized, so the business profile can no longer be changed."
  );
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
  let committedStages = [];
  let changedConfigKeys = [];

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

    const storedConfig = configResult.rows[0].data || {};
    const setup = normalizeIndustrySetup(storedConfig.industrySetup);
    if (setup.selectable !== true || setup.locked === true) {
      throw conflict(
        "INDUSTRY_PROFILE_LOCKED",
        "This deployment's business profile is already locked and cannot be changed from Setup Status."
      );
    }

    // Cheap preflight checks reject established/customized deployments before
    // taking table-wide locks. These are safety hints only and are repeated
    // after the strong locks below before any destructive mutation can happen.
    const currentPipelineProfile = getPipelineProfile(storedConfig);
    assertNoCustomerData(await queryCustomerDataState(client));
    assertDefaultPipeline(await loadStageRows(client), currentPipelineProfile);

    // Keep shared lock order compatible with startup Pipeline reconciliation:
    // pipeline_stages must be acquired before leads. contacts/messages come
    // first so inbound customer writes are also blocked before the final
    // zero-data recheck. This avoids a Render rolling-deploy deadlock where
    // startup holds pipeline_stages while a profile switch holds leads.
    await client.query("LOCK TABLE contacts IN SHARE ROW EXCLUSIVE MODE");
    await client.query("LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE");
    await client.query("LOCK TABLE pipeline_stages IN ACCESS EXCLUSIVE MODE");
    await client.query("LOCK TABLE leads IN SHARE ROW EXCLUSIVE MODE");

    const customerData = await queryCustomerDataState(client);
    assertNoCustomerData(customerData);

    const stageRows = await loadStageRows(client);
    assertDefaultPipeline(stageRows, currentPipelineProfile);

    nextConfig = buildSelectedConfig(storedConfig, businessType, now);
    nextPipelineProfile = getPipelineProfile(nextConfig);
    changedConfigKeys = [
      ...new Set([...Object.keys(storedConfig), ...Object.keys(nextConfig)]),
    ];

    await client.query(
      "UPDATE clinic_config SET data = $1, updated_at = now() WHERE id = 1",
      [nextConfig]
    );

    // Confirming the already-selected default profile only needs to lock the
    // onboarding metadata. Preserve identical stage rows and their IDs instead
    // of deleting/reinserting a Pipeline that is already correct.
    const changingIndustry = businessType !== currentPipelineProfile.businessType;
    if (changingIndustry) {
      await client.query("DELETE FROM pipeline_stages");
      await insertStages(client, nextPipelineProfile.defaultStages);
      committedStages = profileStageRows(nextPipelineProfile);
    } else {
      committedStages = stageRows;
    }

    await client.query("COMMIT");
    inTransaction = false;
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  replaceLiveConfig(nextConfig);
  setAnalyticsProfileForStages(nextPipelineProfile, committedStages);
  realtimeEvents.publish("config_changed", {
    // Profile selection replaces the whole profile-owned config. Publish the
    // full top-level key union so workers that subscribe to automatedFollowUp,
    // leadScoring, or future config sections immediately reconcile their state.
    keys: changedConfigKeys,
  });
  realtimeEvents.publish("pipeline_changed", {
    reason: "industry_profile_selected",
    businessType,
  });

  // The irreversible transaction has already committed. Return status from the
  // committed snapshot so a transient diagnostic query cannot turn success into
  // an apparent 500 that encourages an unsafe retry.
  return buildIndustrySetupStatus(nextConfig, {
    customerData: normalizeCustomerDataRow(),
    stages: committedStages,
  });
}

module.exports = {
  buildIndustrySetupStatus,
  buildSelectedConfig,
  getIndustrySetupStatus,
  loadCustomerDataState,
  normalizeCustomerDataRow,
  replaceLiveConfig,
  selectIndustryProfile,
};
