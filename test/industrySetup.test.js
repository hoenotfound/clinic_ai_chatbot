const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clinicConfig = require("../src/config/clinicConfig");
const {
  DEFAULT_BUSINESS_TYPE,
  getIndustryProfile,
} = require("../src/config/industryProfiles");
const {
  createSeedIndustrySetup,
  getBusinessProfileOptions,
  lockIndustrySetup,
  normalizeIndustrySetup,
} = require("../src/config/industrySetup");
const {
  CLINIC_DEFAULT_STAGES,
  getPipelineProfile,
} = require("../src/config/pipelineProfiles");
const {
  buildSelectedConfig,
  selectIndustryProfile,
} = require("../src/db/industrySetupRepo");
const { DEFAULT_LEAD_DISTRIBUTION } = require("../src/utils/leadDistribution");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dbStage(stage, id) {
  return {
    id,
    name: stage.name,
    sort_order: stage.sortOrder,
    color: stage.color,
    stage_type: stage.stageType,
    system_key: stage.systemKey,
  };
}

function createSelectableClinicConfig() {
  return {
    ...getIndustryProfile("aesthetic_clinic"),
    leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
    industrySetup: {
      selectable: true,
      locked: false,
      source: "default",
      selectedAt: null,
      lockReason: null,
    },
  };
}

function createIndustryDatabase({
  storedConfig = createSelectableClinicConfig(),
  stages = CLINIC_DEFAULT_STAGES.map(dbStage),
  hasContacts = false,
  hasMessages = false,
  hasLeads = false,
} = {}) {
  const queries = [];
  let currentStages = stages.map((stage) => ({ ...stage }));
  let savedConfig = clone(storedConfig);
  let released = false;

  function customerDataRows() {
    return [{
      has_contacts: hasContacts,
      has_messages: hasMessages,
      has_leads: hasLeads,
    }];
  }

  const client = {
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE/.test(sql)) {
        return { rows: [{ data: clone(savedConfig) }] };
      }
      if (/EXISTS \(SELECT 1 FROM contacts LIMIT 1\)/.test(sql)) {
        return { rows: customerDataRows() };
      }
      if (/SELECT id, name, sort_order, color, stage_type, system_key/.test(sql)) {
        return { rows: currentStages.map((stage) => ({ ...stage })) };
      }
      if (/UPDATE clinic_config SET data/.test(sql)) {
        savedConfig = clone(params[0]);
        return { rows: [] };
      }
      if (sql === "DELETE FROM pipeline_stages") {
        currentStages = [];
        return { rows: [] };
      }
      if (/INSERT INTO pipeline_stages/.test(sql)) {
        currentStages.push({
          id: currentStages.length + 1,
          name: params[0],
          sort_order: params[1],
          color: params[2],
          stage_type: params[3],
          system_key: params[4],
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };

  const database = {
    connect: async () => client,
    query: async (sql) => {
      if (/EXISTS \(SELECT 1 FROM contacts LIMIT 1\)/.test(sql)) {
        return { rows: customerDataRows() };
      }
      if (/SELECT id, name, sort_order, color, stage_type, system_key/.test(sql)) {
        return { rows: currentStages.map((stage) => ({ ...stage })) };
      }
      return { rows: [] };
    },
  };

  return {
    database,
    queries,
    getSavedConfig: () => clone(savedConfig),
    getStages: () => currentStages.map((stage) => ({ ...stage })),
    wasReleased: () => released,
  };
}

test("Aesthetic Clinic remains the zero-config default and is marked as the default option", () => {
  assert.equal(DEFAULT_BUSINESS_TYPE, "aesthetic_clinic");

  const setup = createSeedIndustrySetup({});
  assert.deepEqual(setup, {
    selectable: true,
    locked: false,
    source: "default",
    selectedAt: null,
    lockReason: null,
  });

  const options = getBusinessProfileOptions();
  assert.equal(options.find((option) => option.value === "aesthetic_clinic")?.default, true);
  assert.equal(options.find((option) => option.value === "home_renovation")?.default, false);
});

test("explicit provisioning locks the selected industry while legacy deployments fail closed", () => {
  const selectedAt = new Date("2026-09-08T08:00:00.000Z");
  const explicit = createSeedIndustrySetup(
    { INITIAL_BUSINESS_TYPE: "home_renovation" },
    selectedAt
  );
  assert.deepEqual(explicit, {
    selectable: false,
    locked: true,
    source: "environment",
    selectedAt: selectedAt.toISOString(),
    lockReason: "environment_selected",
  });

  assert.deepEqual(normalizeIndustrySetup(null), {
    selectable: false,
    locked: true,
    source: "legacy",
    selectedAt: null,
    lockReason: "legacy_existing_deployment",
  });
});

test("locking a default seed is one-way and records why configuration started", () => {
  const now = new Date("2026-09-08T08:10:00.000Z");
  const locked = lockIndustrySetup(createSeedIndustrySetup({}), {
    source: "settings",
    reason: "settings_configured",
    now,
  });
  assert.equal(locked.selectable, false);
  assert.equal(locked.locked, true);
  assert.equal(locked.source, "settings");
  assert.equal(locked.lockReason, "settings_configured");
  assert.equal(locked.selectedAt, now.toISOString());
});

test("selected profile resets client-facing defaults instead of carrying clinic facts into renovation", () => {
  const stored = createSelectableClinicConfig();
  stored.telegramConversationSummary = { enabled: true };
  const next = buildSelectedConfig(
    stored,
    "home_renovation",
    new Date("2026-09-08T08:20:00.000Z")
  );

  assert.equal(next.businessType, "home_renovation");
  assert.deepEqual(next.services, []);
  assert.deepEqual(next.branches, []);
  assert.deepEqual(next.leadDistribution, DEFAULT_LEAD_DISTRIBUTION);
  assert.deepEqual(next.telegramConversationSummary, { enabled: true });
  assert.equal(next.industrySetup.locked, true);
  assert.equal(next.industrySetup.selectable, false);
  assert.equal(next.industrySetup.source, "setup_status");
  assert.equal(next.industrySetup.lockReason, "profile_confirmed");
});

test("atomic industry selection replaces untouched clinic config and Pipeline with renovation defaults", async () => {
  const snapshot = clone(clinicConfig);
  const fake = createIndustryDatabase();

  try {
    const status = await selectIndustryProfile(
      "home_renovation",
      fake.database,
      new Date("2026-09-08T08:30:00.000Z")
    );

    const saved = fake.getSavedConfig();
    assert.equal(saved.businessType, "home_renovation");
    assert.equal(saved.industrySetup.locked, true);
    assert.equal(saved.industrySetup.source, "setup_status");
    assert.deepEqual(saved.services, []);
    assert.deepEqual(saved.branches, []);

    const expectedPipeline = getPipelineProfile({ businessType: "home_renovation" });
    assert.deepEqual(
      fake.getStages().map((stage) => [stage.name, stage.system_key]),
      expectedPipeline.defaultStages.map((stage) => [stage.name, stage.systemKey])
    );
    assert.equal(status.businessType, "home_renovation");
    assert.equal(status.selection.locked, true);
    assert.equal(status.alignment.pipeline.businessType, "home_renovation");
    assert.equal(status.alignment.conversion.mode, "project");
    assert.equal(status.alignment.leadTemperature.mode, "project");
    assert.equal(status.alignment.analytics.businessType, "home_renovation");

    const updateIndex = fake.queries.findIndex(({ sql }) => /UPDATE clinic_config SET data/.test(sql));
    const deleteIndex = fake.queries.findIndex(({ sql }) => sql === "DELETE FROM pipeline_stages");
    const commitIndex = fake.queries.findIndex(({ sql }) => sql === "COMMIT");
    assert.ok(updateIndex >= 0 && deleteIndex > updateIndex && commitIndex > deleteIndex);
    assert.equal(fake.wasReleased(), true);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, snapshot);
  }
});

test("customer data blocks industry switching before any config or Pipeline mutation", async () => {
  const fake = createIndustryDatabase({ hasContacts: true });

  await assert.rejects(
    selectIndustryProfile("home_renovation", fake.database),
    (err) => err?.code === "INDUSTRY_PROFILE_HAS_DATA" && err?.status === 409
  );

  assert.equal(fake.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);
  assert.equal(fake.queries.some(({ sql }) => sql === "DELETE FROM pipeline_stages"), false);
  assert.equal(fake.queries.some(({ sql }) => sql === "ROLLBACK"), true);
  assert.equal(fake.wasReleased(), true);
});

test("customized Pipeline and legacy setup metadata both block industry switching", async () => {
  const customizedStages = CLINIC_DEFAULT_STAGES.map(dbStage);
  customizedStages[2] = { ...customizedStages[2], name: "Custom Qualification" };
  const customized = createIndustryDatabase({ stages: customizedStages });

  await assert.rejects(
    selectIndustryProfile("home_renovation", customized.database),
    (err) => err?.code === "INDUSTRY_PROFILE_PIPELINE_CUSTOMIZED"
  );
  assert.equal(customized.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);

  const legacyConfig = getIndustryProfile("aesthetic_clinic");
  const legacy = createIndustryDatabase({ storedConfig: legacyConfig });
  await assert.rejects(
    selectIndustryProfile("home_renovation", legacy.database),
    (err) => err?.code === "INDUSTRY_PROFILE_LOCKED"
  );
  assert.equal(legacy.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);
});

test("normal Settings cannot patch businessType and the portal exposes only the dedicated Setup Status action", () => {
  const configRoute = fs.readFileSync(path.join(__dirname, "../src/routes/config.js"), "utf8");
  const setupRoute = fs.readFileSync(path.join(__dirname, "../src/routes/setupStatus.js"), "utf8");
  const apiSource = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/api.js"), "utf8");
  const setupPage = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/pages/SetupStatus.jsx"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/components/BusinessProfileSetupPanel.jsx"), "utf8");

  assert.doesNotMatch(configRoute, /businessType\s*:/);
  assert.match(setupRoute, /router\.post\("\/business-profile"/);
  assert.match(apiSource, /selectBusinessProfile/);
  assert.match(apiSource, /\/setup-status\/business-profile/);
  assert.match(setupPage, /<BusinessProfileSetupPanel profile=\{data\.businessProfile\}/);
  assert.match(panel, /Aesthetic Clinic is the default/);
  assert.match(panel, />Default</);
  assert.match(panel, /window\.confirm/);
});
