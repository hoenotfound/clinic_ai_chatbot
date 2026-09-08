const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clinicConfig = require("../src/config/clinicConfig");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const { CLINIC_DEFAULT_STAGES } = require("../src/config/pipelineProfiles");
const {
  setRuntimeAnalyticsPipelineBusinessType,
} = require("../src/db/analyticsPipelineProfile");
const { selectIndustryProfile } = require("../src/db/industrySetupRepo");
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

function selectableClinicConfig() {
  return {
    ...getIndustryProfile("aesthetic_clinic"),
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

function clinicStageRows() {
  return CLINIC_DEFAULT_STAGES.map((stage, index) => ({
    id: index + 1,
    name: stage.name,
    sort_order: stage.sortOrder,
    color: stage.color,
    stage_type: stage.stageType,
    system_key: stage.systemKey,
  }));
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

function createConcurrentSelectionDatabase() {
  let savedConfig = clone(selectableClinicConfig());
  let stages = clinicStageRows();
  let lockOwner = null;
  const waiters = [];
  let nextClientId = 1;

  async function acquireRowLock(clientId) {
    if (lockOwner === null) {
      lockOwner = clientId;
      return;
    }
    await new Promise((resolve) => waiters.push({ clientId, resolve }));
  }

  function releaseRowLock(clientId) {
    if (lockOwner !== clientId) return;
    const next = waiters.shift();
    if (next) {
      lockOwner = next.clientId;
      next.resolve();
    } else {
      lockOwner = null;
    }
  }

  function createClient() {
    const clientId = nextClientId++;
    let ownsRowLock = false;

    return {
      async query(sql, params = []) {
        if (sql === "BEGIN") return { rows: [] };
        if (sql === "COMMIT" || sql === "ROLLBACK") {
          if (ownsRowLock) {
            releaseRowLock(clientId);
            ownsRowLock = false;
          }
          return { rows: [] };
        }
        if (/SELECT data FROM clinic_config WHERE id = 1 FOR UPDATE/.test(sql)) {
          await acquireRowLock(clientId);
          ownsRowLock = true;
          return { rows: [{ data: clone(savedConfig) }] };
        }
        if (/EXISTS \(SELECT 1 FROM contacts LIMIT 1\)/.test(sql)) {
          return {
            rows: [{ has_contacts: false, has_messages: false, has_leads: false }],
          };
        }
        if (/SELECT id, name, sort_order, color, stage_type, system_key/.test(sql)) {
          return { rows: stages.map((stage) => ({ ...stage })) };
        }
        if (/^LOCK TABLE/.test(sql)) return { rows: [] };
        if (/UPDATE clinic_config SET data/.test(sql)) {
          savedConfig = clone(params[0]);
          return { rows: [] };
        }
        if (sql === "DELETE FROM pipeline_stages") {
          stages = [];
          return { rows: [] };
        }
        if (/INSERT INTO pipeline_stages/.test(sql)) {
          stages.push({
            id: stages.length + 1,
            name: params[0],
            sort_order: params[1],
            color: params[2],
            stage_type: params[3],
            system_key: params[4],
          });
          return { rows: [] };
        }
        throw new Error(`Unexpected SQL in concurrent profile test: ${sql}`);
      },
      release() {
        if (ownsRowLock) {
          releaseRowLock(clientId);
          ownsRowLock = false;
        }
      },
    };
  }

  return {
    database: { connect: async () => createClient() },
    getSavedConfig: () => clone(savedConfig),
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

test("two simultaneous profile selections serialize and only one can commit", async () => {
  const originalLive = clone(clinicConfig);
  const fake = createConcurrentSelectionDatabase();

  try {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, selectableClinicConfig());

    const results = await Promise.allSettled([
      selectIndustryProfile(
        "home_renovation",
        fake.database,
        new Date("2026-09-08T09:10:00.000Z"),
        "admin-one"
      ),
      selectIndustryProfile(
        "generic",
        fake.database,
        new Date("2026-09-08T09:10:00.001Z"),
        "admin-two"
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.code, "INDUSTRY_PROFILE_LOCKED");

    const committed = fake.getSavedConfig();
    assert.equal(committed.industrySetup.locked, true);
    assert.equal(committed.businessType, fulfilled[0].value.businessType);
    assert.equal(
      committed.industrySetup.selectedBy,
      committed.businessType === "home_renovation" ? "admin-one" : "admin-two"
    );
  } finally {
    for (const key of Object.keys(clinicConfig)) delete clinicConfig[key];
    Object.assign(clinicConfig, originalLive);
    setRuntimeAnalyticsPipelineBusinessType(originalLive.businessType || "aesthetic_clinic");
  }
});

test("Setup Status passes the authenticated administrator into profile audit metadata", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../src/routes/setupStatus.js"),
    "utf8"
  );

  assert.match(
    routeSource,
    /selectIndustryProfile\(businessType,\s*\{\s*actor:\s*req\.session\?\.username\s*\|\|\s*null,?\s*\}\)/
  );
});
