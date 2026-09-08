const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const { getOnboardingIndustryProfile } = require("../src/config/onboardingIndustryProfiles");
const { CLINIC_DEFAULT_STAGES } = require("../src/config/pipelineProfiles");
const { updateConfig } = require("../src/db/configRepo");
const { DEFAULT_LEAD_DISTRIBUTION } = require("../src/utils/leadDistribution");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freshSelectableClinic() {
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

function clinicStageRows({ customized = false } = {}) {
  return CLINIC_DEFAULT_STAGES.map((stage, index) => ({
    id: index + 1,
    name: customized && index === 1 ? "Custom Qualification" : stage.name,
    sort_order: stage.sortOrder,
    color: stage.color,
    stage_type: stage.stageType,
    system_key: stage.systemKey,
  }));
}

function createDatabase({ hasCustomerData = false, customizedPipeline = false } = {}) {
  let savedConfig = clone(freshSelectableClinic());
  const queries = [];
  const stages = clinicStageRows({ customized: customizedPipeline });

  const client = {
    async query(sql, params = []) {
      queries.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (/SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE/.test(sql)) {
        return { rows: [{ data: clone(savedConfig) }] };
      }
      if (/EXISTS \(SELECT 1 FROM contacts LIMIT 1\)/.test(sql)) {
        return {
          rows: [{
            has_contacts: hasCustomerData,
            has_messages: false,
            has_leads: false,
          }],
        };
      }
      if (/SELECT id, name, sort_order, color, stage_type, system_key/.test(sql)) {
        return { rows: stages.map((stage) => ({ ...stage })) };
      }
      if (/UPDATE clinic_config SET data/.test(sql)) {
        savedConfig = clone(params[0]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in profile lock recovery test: ${sql}`);
    },
    release() {},
  };

  return {
    database: { connect: async () => client },
    getSavedConfig: () => clone(savedConfig),
    queries,
  };
}

test("fresh untouched Settings remain blocked until the Business Profile is confirmed", async () => {
  const fake = createDatabase({ hasCustomerData: false });

  await assert.rejects(
    updateConfig({ aiAssistantName: "Taylor" }, fake.database),
    (err) =>
      err?.status === 409 &&
      err?.code === "INDUSTRY_PROFILE_NOT_CONFIRMED"
  );

  const saved = fake.getSavedConfig();
  assert.equal(saved.industrySetup.selectable, true);
  assert.equal(saved.industrySetup.locked, false);
  assert.equal(saved.aiAssistantName, "Alex");
  assert.equal(fake.queries.some((sql) => /UPDATE clinic_config SET data/.test(sql)), false);
  assert.equal(fake.queries.includes("ROLLBACK"), true);
});

test("customer activity locks the current default profile and Settings remain usable", async () => {
  const snapshot = clone(clinicConfig);
  const fake = createDatabase({ hasCustomerData: true });

  try {
    const updated = await updateConfig({ aiAssistantName: "Taylor" }, fake.database);
    const saved = fake.getSavedConfig();

    assert.equal(saved.businessType, "aesthetic_clinic");
    assert.equal(saved.aiAssistantName, "Taylor");
    assert.equal(saved.industrySetup.selectable, false);
    assert.equal(saved.industrySetup.locked, true);
    assert.equal(saved.industrySetup.source, "customer_data");
    assert.equal(saved.industrySetup.lockReason, "customer_data_exists");
    assert.ok(!Number.isNaN(Date.parse(saved.industrySetup.selectedAt)));

    assert.equal(updated.businessType, "aesthetic_clinic");
    assert.equal(updated.aiAssistantName, "Taylor");
    assert.equal(updated.industrySetup.locked, true);
    assert.equal(updated.industrySetup.lockReason, "customer_data_exists");
    assert.equal(fake.queries.includes("COMMIT"), true);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, snapshot);
  }
});

test("a customized Pipeline recovers a missing profile lock and keeps Settings usable", async () => {
  const snapshot = clone(clinicConfig);
  const fake = createDatabase({
    hasCustomerData: false,
    customizedPipeline: true,
  });

  try {
    const updated = await updateConfig({ aiAssistantName: "Taylor" }, fake.database);
    const saved = fake.getSavedConfig();

    assert.equal(saved.businessType, "aesthetic_clinic");
    assert.equal(saved.aiAssistantName, "Taylor");
    assert.equal(saved.industrySetup.selectable, false);
    assert.equal(saved.industrySetup.locked, true);
    assert.equal(saved.industrySetup.source, "pipeline");
    assert.equal(saved.industrySetup.lockReason, "pipeline_customized");
    assert.ok(!Number.isNaN(Date.parse(saved.industrySetup.selectedAt)));

    assert.equal(updated.industrySetup.locked, true);
    assert.equal(updated.industrySetup.lockReason, "pipeline_customized");
    assert.equal(fake.queries.includes("COMMIT"), true);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, snapshot);
  }
});
