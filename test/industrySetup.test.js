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
  buildFreshAestheticClinicProfile,
  getOnboardingIndustryProfile,
} = require("../src/config/onboardingIndustryProfiles");
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
  setRuntimeAnalyticsPipelineBusinessType,
} = require("../src/db/analyticsPipelineProfile");
const {
  buildSelectedConfig,
  selectIndustryProfile,
} = require("../src/db/industrySetupRepo");
const {
  CONFIG_KEYS,
  withPipelineCustomizationLock,
} = require("../src/db/configRepo");
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
    ...getOnboardingIndustryProfile("aesthetic_clinic"),
    leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
    industrySetup: {
      selectable: true,
      locked: false,
      source: "default",
      selectedAt: null,
      selectedBy: null,
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
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || /^LOCK TABLE/.test(sql)) {
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

test("Aesthetic Clinic remains the default but fresh clinic onboarding is neutral", () => {
  assert.equal(DEFAULT_BUSINESS_TYPE, "aesthetic_clinic");

  const profile = buildFreshAestheticClinicProfile();
  const serialized = JSON.stringify(profile);
  assert.equal(profile.businessType, "aesthetic_clinic");
  assert.equal(profile.businessName, "Your Clinic");
  assert.deepEqual(profile.branches, []);
  assert.deepEqual(profile.services, []);
  assert.deepEqual(profile.promotions, []);
  assert.deepEqual(profile.faqs, []);
  assert.doesNotMatch(serialized, /Beleco/i);
  assert.doesNotMatch(serialized, /HIFU Buy 1 Free 1/i);

  const setup = createSeedIndustrySetup({});
  assert.deepEqual(setup, {
    selectable: true,
    locked: false,
    source: "default",
    selectedAt: null,
    selectedBy: null,
    lockReason: null,
  });

  const options = getBusinessProfileOptions();
  assert.equal(options.find((option) => option.value === "aesthetic_clinic")?.default, true);
  assert.equal(options.find((option) => option.value === "home_renovation")?.default, false);
});

test("legacy clinic profile still preserves historical stored/default compatibility data", () => {
  const legacy = getIndustryProfile("aesthetic_clinic");
  assert.equal(legacy.businessType, "aesthetic_clinic");
  assert.equal(legacy.clinicName, "Beleco Clinic");
  assert.ok(legacy.branches.length > 0);
  assert.ok(legacy.services.length > 0);
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
    selectedBy: null,
    lockReason: "environment_selected",
  });

  assert.deepEqual(normalizeIndustrySetup(null), {
    selectable: false,
    locked: true,
    source: "legacy",
    selectedAt: null,
    selectedBy: null,
    lockReason: "legacy_existing_deployment",
  });
});

test("locking a profile is one-way and records the actor", () => {
  const now = new Date("2026-09-08T08:10:00.000Z");
  const locked = lockIndustrySetup(createSeedIndustrySetup({}), {
    source: "setup_status",
    reason: "profile_confirmed",
    actor: "admin",
    now,
  });
  assert.equal(locked.selectable, false);
  assert.equal(locked.locked, true);
  assert.equal(locked.source, "setup_status");
  assert.equal(locked.lockReason, "profile_confirmed");
  assert.equal(locked.selectedAt, now.toISOString());
  assert.equal(locked.selectedBy, "admin");
});

test("selected renovation resets client facts and records who confirmed it", () => {
  const stored = createSelectableClinicConfig();
  stored.telegramConversationSummary = { enabled: true };
  const next = buildSelectedConfig(
    stored,
    "home_renovation",
    new Date("2026-09-08T08:20:00.000Z"),
    "caden"
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
  assert.equal(next.industrySetup.selectedBy, "caden");
});

test("atomic industry selection uses deadlock-safe locks and aligns renovation defaults", async () => {
  const snapshot = clone(clinicConfig);
  const fake = createIndustryDatabase();

  try {
    const status = await selectIndustryProfile(
      "home_renovation",
      fake.database,
      new Date("2026-09-08T08:30:00.000Z"),
      "admin"
    );

    const saved = fake.getSavedConfig();
    assert.equal(saved.businessType, "home_renovation");
    assert.equal(saved.industrySetup.locked, true);
    assert.equal(saved.industrySetup.selectedBy, "admin");
    assert.deepEqual(saved.services, []);
    assert.deepEqual(saved.branches, []);

    const expectedPipeline = getPipelineProfile({ businessType: "home_renovation" });
    assert.deepEqual(
      fake.getStages().map((stage) => [stage.name, stage.system_key]),
      expectedPipeline.defaultStages.map((stage) => [stage.name, stage.systemKey])
    );
    assert.equal(status.businessType, "home_renovation");
    assert.equal(status.selection.locked, true);
    assert.equal(status.selection.selectedBy, "admin");
    assert.equal(status.alignment.pipeline.businessType, "home_renovation");
    assert.equal(status.alignment.conversion.mode, "project");
    assert.equal(status.alignment.leadTemperature.mode, "project");
    assert.equal(status.alignment.analytics.businessType, "home_renovation");

    const lockStatements = fake.queries
      .map(({ sql }) => sql)
      .filter((sql) => /^LOCK TABLE/.test(sql));
    assert.deepEqual(lockStatements, [
      "LOCK TABLE contacts IN SHARE ROW EXCLUSIVE MODE",
      "LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE",
      "LOCK TABLE pipeline_stages IN ACCESS EXCLUSIVE MODE",
      "LOCK TABLE leads IN SHARE ROW EXCLUSIVE MODE",
    ]);

    const updateIndex = fake.queries.findIndex(({ sql }) => /UPDATE clinic_config SET data/.test(sql));
    const deleteIndex = fake.queries.findIndex(({ sql }) => sql === "DELETE FROM pipeline_stages");
    const commitIndex = fake.queries.findIndex(({ sql }) => sql === "COMMIT");
    assert.ok(updateIndex >= 0 && deleteIndex > updateIndex && commitIndex > deleteIndex);
    assert.equal(fake.wasReleased(), true);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, snapshot);
    setRuntimeAnalyticsPipelineBusinessType(snapshot.businessType || "aesthetic_clinic");
  }
});

test("confirming the already-selected Clinic profile preserves existing stage ids", async () => {
  const snapshot = clone(clinicConfig);
  const fake = createIndustryDatabase();
  const beforeIds = fake.getStages().map((stage) => stage.id);

  try {
    const status = await selectIndustryProfile(
      "aesthetic_clinic",
      fake.database,
      new Date("2026-09-08T08:35:00.000Z"),
      "admin"
    );

    assert.equal(status.businessType, "aesthetic_clinic");
    assert.equal(status.selection.locked, true);
    assert.deepEqual(fake.getStages().map((stage) => stage.id), beforeIds);
    assert.equal(fake.queries.some(({ sql }) => sql === "DELETE FROM pipeline_stages"), false);
    assert.equal(fake.queries.some(({ sql }) => /INSERT INTO pipeline_stages/.test(sql)), false);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, snapshot);
    setRuntimeAnalyticsPipelineBusinessType(snapshot.businessType || "aesthetic_clinic");
  }
});

test("already locked profiles reject before taking strong table locks", async () => {
  const stored = createSelectableClinicConfig();
  stored.industrySetup = lockIndustrySetup(stored.industrySetup, {
    actor: "admin",
  });
  const fake = createIndustryDatabase({ storedConfig: stored });

  await assert.rejects(
    selectIndustryProfile("home_renovation", fake.database),
    (err) => err?.code === "INDUSTRY_PROFILE_LOCKED" && err?.status === 409
  );

  assert.equal(fake.queries.some(({ sql }) => /^LOCK TABLE/.test(sql)), false);
  assert.equal(fake.queries.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("customer data blocks selection before strong locks or mutations", async () => {
  const fake = createIndustryDatabase({ hasContacts: true });

  await assert.rejects(
    selectIndustryProfile("home_renovation", fake.database),
    (err) => err?.code === "INDUSTRY_PROFILE_HAS_DATA" && err?.status === 409
  );

  assert.equal(fake.queries.some(({ sql }) => /^LOCK TABLE/.test(sql)), false);
  assert.equal(fake.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);
  assert.equal(fake.queries.some(({ sql }) => sql === "DELETE FROM pipeline_stages"), false);
});

test("customized Pipeline and legacy setup metadata both block industry switching", async () => {
  const customizedStages = CLINIC_DEFAULT_STAGES.map(dbStage);
  customizedStages[2] = { ...customizedStages[2], name: "Custom Qualification" };
  const customized = createIndustryDatabase({ stages: customizedStages });

  await assert.rejects(
    selectIndustryProfile("home_renovation", customized.database),
    (err) => err?.code === "INDUSTRY_PROFILE_PIPELINE_CUSTOMIZED"
  );
  assert.equal(customized.queries.some(({ sql }) => /^LOCK TABLE/.test(sql)), false);
  assert.equal(customized.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);

  const legacyConfig = getIndustryProfile("aesthetic_clinic");
  const legacy = createIndustryDatabase({ storedConfig: legacyConfig });
  await assert.rejects(
    selectIndustryProfile("home_renovation", legacy.database),
    (err) => err?.code === "INDUSTRY_PROFILE_LOCKED"
  );
  assert.equal(legacy.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);
});

test("first successful Pipeline customization permanently locks the profile", async () => {
  const snapshot = clone(clinicConfig);
  const fake = createIndustryDatabase();

  try {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, createSelectableClinicConfig());

    const result = await withPipelineCustomizationLock(
      async () => ({ id: 99, name: "Custom" }),
      {
        actor: "pipeline-admin",
        database: fake.database,
        now: new Date("2026-09-08T08:40:00.000Z"),
      }
    );

    assert.equal(result.id, 99);
    const setup = fake.getSavedConfig().industrySetup;
    assert.equal(setup.locked, true);
    assert.equal(setup.selectable, false);
    assert.equal(setup.source, "pipeline");
    assert.equal(setup.lockReason, "pipeline_customized");
    assert.equal(setup.selectedBy, "pipeline-admin");
    assert.equal(clinicConfig.industrySetup.lockReason, "pipeline_customized");
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, snapshot);
  }
});

test("failed or not-found Pipeline mutation does not lock the profile", async () => {
  const fake = createIndustryDatabase();

  const result = await withPipelineCustomizationLock(
    async () => null,
    { database: fake.database }
  );

  assert.equal(result, null);
  assert.equal(fake.getSavedConfig().industrySetup.locked, false);
  assert.equal(fake.queries.some(({ sql }) => /UPDATE clinic_config SET data/.test(sql)), false);
});

test("normal Settings cannot patch businessType and Setup Status remains the dedicated selector", () => {
  const configRepo = fs.readFileSync(path.join(__dirname, "../src/db/configRepo.js"), "utf8");
  const setupRoute = fs.readFileSync(path.join(__dirname, "../src/routes/setupStatus.js"), "utf8");
  const pipelineRoute = fs.readFileSync(path.join(__dirname, "../src/routes/pipeline.js"), "utf8");
  const apiSource = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/api.js"), "utf8");
  const setupPage = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/pages/SetupStatus.jsx"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/components/BusinessProfileSetupPanel.jsx"), "utf8");

  assert.equal(CONFIG_KEYS.includes("businessType"), false);
  assert.match(configRepo, /INDUSTRY_PROFILE_NOT_CONFIRMED/);
  assert.match(configRepo, /withPipelineCustomizationLock/);
  assert.match(setupRoute, /router\.post\("\/business-profile"/);
  assert.match(pipelineRoute, /withStageCustomizationLock/);
  assert.match(apiSource, /selectBusinessProfile/);
  assert.match(apiSource, /\/setup-status\/business-profile/);
  assert.match(setupPage, /<BusinessProfileSetupPanel profile=\{data\.businessProfile\}/);
  assert.match(panel, /Aesthetic Clinic is the default/);
  assert.match(panel, />Default</);
  assert.match(panel, /window\.confirm/);
});
