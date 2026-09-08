const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const { updateConfig } = require("../src/db/configRepo");
const { DEFAULT_LEAD_DISTRIBUTION } = require("../src/utils/leadDistribution");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function lockedRenovationConfig() {
  return {
    ...getIndustryProfile("home_renovation"),
    leadDistribution: { ...DEFAULT_LEAD_DISTRIBUTION },
    industrySetup: {
      selectable: false,
      locked: true,
      source: "setup_status",
      selectedAt: "2026-09-08T09:00:00.000Z",
      lockReason: "profile_confirmed",
    },
  };
}

function createConfigDatabase(storedConfig) {
  const queries = [];
  let savedConfig = clone(storedConfig);
  let released = false;

  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (/SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE/.test(sql)) {
        return { rows: [{ data: clone(savedConfig) }] };
      }
      if (/UPDATE clinic_config SET data/.test(sql)) {
        savedConfig = clone(params[0]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in config test: ${sql}`);
    },
    release() {
      released = true;
    },
  };

  return {
    database: { connect: async () => client },
    queries,
    getSavedConfig: () => clone(savedConfig),
    wasReleased: () => released,
  };
}

test("Settings rebuild from the locked DB config instead of stale live clinic state", async () => {
  const originalLive = clone(clinicConfig);
  const staleClinic = {
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
  const fake = createConfigDatabase(lockedRenovationConfig());

  try {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, staleClinic);

    await updateConfig({ aiAssistantName: "Taylor" }, fake.database);

    const saved = fake.getSavedConfig();
    assert.equal(saved.businessType, "home_renovation");
    assert.equal(saved.aiAssistantName, "Taylor");
    assert.deepEqual(saved.services, []);
    assert.deepEqual(saved.branches, []);
    assert.equal(saved.industrySetup.locked, true);
    assert.equal(saved.industrySetup.source, "setup_status");

    assert.equal(clinicConfig.businessType, "home_renovation");
    assert.equal(clinicConfig.aiAssistantName, "Taylor");
    assert.deepEqual(clinicConfig.services, []);

    assert.equal(fake.queries[0].sql, "BEGIN");
    assert.equal(
      fake.queries[1].sql,
      "SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE"
    );
    assert.match(fake.queries[2].sql, /UPDATE clinic_config SET data/);
    assert.equal(fake.queries[3].sql, "COMMIT");
    assert.equal(fake.wasReleased(), true);
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, originalLive);
  }
});
