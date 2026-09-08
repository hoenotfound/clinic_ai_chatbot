const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CLINIC_DEFAULT_STAGES,
  getPipelineProfile,
} = require("../src/config/pipelineProfiles");
const {
  ensureIndustryPipelineDefaults,
  stagesExactlyMatch,
} = require("../src/db/pipelineDefaultsRepo");

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

function createPipelineDatabase({ stages = [], leadCount = 0 } = {}) {
  const queries = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id, name, sort_order, color, stage_type, system_key/.test(sql)) {
        return { rows: stages };
      }
      if (/SELECT COUNT\(\*\)::int AS count FROM leads/.test(sql)) {
        return { rows: [{ count: leadCount }] };
      }
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  return {
    database: { connect: async () => client },
    queries,
    wasReleased: () => released,
  };
}

test("pipeline profiles preserve clinic defaults and give renovation semantic stages", () => {
  const clinic = getPipelineProfile({ businessType: "aesthetic_clinic" });
  const renovation = getPipelineProfile({ businessType: "home_renovation" });
  const generic = getPipelineProfile({ businessType: "generic" });

  assert.deepEqual(clinic.defaultStages, CLINIC_DEFAULT_STAGES.map((stage) => ({ ...stage })));
  assert.deepEqual(
    renovation.defaultStages.map(({ name, systemKey }) => [name, systemKey]),
    [
      ["New Lead", "new"],
      ["Contacted", "contacted"],
      ["Qualified", "qualified"],
      ["Quotation / Site Visit", "next_step"],
      ["Decision", "decision"],
      ["Won", "won"],
      ["Lost", "lost"],
    ]
  );
  assert.equal(renovation.defaultStages.some((stage) => stage.systemKey === "appointment_set"), false);
  assert.equal(renovation.defaultStages.some((stage) => stage.systemKey === "visited"), false);
  assert.equal(generic.defaultStages.some((stage) => /appointment|clinic|quotation|site visit/i.test(stage.name)), false);
});

test("fresh renovation pipeline replaces only the untouched legacy clinic seed", async () => {
  const existing = CLINIC_DEFAULT_STAGES.map(dbStage);
  const { database, queries, wasReleased } = createPipelineDatabase({ stages: existing });

  const result = await ensureIndustryPipelineDefaults(
    { businessType: "home_renovation" },
    database
  );

  assert.equal(result.changed, true);
  assert.equal(result.reason, "replaced_legacy_default");
  assert.equal(queries.some(({ sql }) => sql === "DELETE FROM pipeline_stages"), true);
  const inserts = queries.filter(({ sql }) => /INSERT INTO pipeline_stages/.test(sql));
  assert.equal(inserts.length, 7);
  assert.deepEqual(inserts.map(({ params }) => [params[0], params[4]]), [
    ["New Lead", "new"],
    ["Contacted", "contacted"],
    ["Qualified", "qualified"],
    ["Quotation / Site Visit", "next_step"],
    ["Decision", "decision"],
    ["Won", "won"],
    ["Lost", "lost"],
  ]);
  assert.equal(queries.at(-1).sql, "COMMIT");
  assert.equal(wasReleased(), true);
});

test("an actually empty pipeline receives the selected industry defaults", async () => {
  const { database, queries } = createPipelineDatabase({ stages: [] });

  const result = await ensureIndustryPipelineDefaults(
    { businessType: "generic" },
    database
  );

  assert.equal(result.changed, true);
  assert.equal(result.reason, "seeded_empty_pipeline");
  assert.equal(queries.some(({ sql }) => sql === "DELETE FROM pipeline_stages"), false);
  assert.equal(queries.filter(({ sql }) => /INSERT INTO pipeline_stages/.test(sql)).length, 6);
});

test("existing customized or in-use pipelines are never reset", async () => {
  const customized = CLINIC_DEFAULT_STAGES.map(dbStage);
  customized[2] = { ...customized[2], name: "Consultation Booked" };

  const customDb = createPipelineDatabase({ stages: customized, leadCount: 0 });
  const customResult = await ensureIndustryPipelineDefaults(
    { businessType: "home_renovation" },
    customDb.database
  );
  assert.deepEqual(customResult, {
    changed: false,
    reason: "customized_pipeline",
    businessType: "home_renovation",
  });
  assert.equal(customDb.queries.some(({ sql }) => /DELETE FROM pipeline_stages|INSERT INTO pipeline_stages/.test(sql)), false);

  const inUseDb = createPipelineDatabase({
    stages: CLINIC_DEFAULT_STAGES.map(dbStage),
    leadCount: 1,
  });
  const inUseResult = await ensureIndustryPipelineDefaults(
    { businessType: "home_renovation" },
    inUseDb.database
  );
  assert.deepEqual(inUseResult, {
    changed: false,
    reason: "pipeline_in_use",
    businessType: "home_renovation",
  });
  assert.equal(inUseDb.queries.some(({ sql }) => /DELETE FROM pipeline_stages|INSERT INTO pipeline_stages/.test(sql)), false);
});

test("clinic fresh pipeline remains byte-for-byte equivalent to the historical defaults", async () => {
  const existing = CLINIC_DEFAULT_STAGES.map(dbStage);
  const { database, queries } = createPipelineDatabase({ stages: existing });

  assert.equal(stagesExactlyMatch(existing, CLINIC_DEFAULT_STAGES), true);
  const result = await ensureIndustryPipelineDefaults(
    { businessType: "aesthetic_clinic" },
    database
  );

  assert.deepEqual(result, {
    changed: false,
    reason: "already_correct",
    businessType: "aesthetic_clinic",
  });
  assert.equal(queries.some(({ sql }) => /DELETE FROM pipeline_stages|INSERT INTO pipeline_stages/.test(sql)), false);
});

test("renovation qualification view merges latest relevant project metadata without using branch_name", async () => {
  const { getBusinessTerminology } = await import(
    "../portal-frontend/src/utils/businessTerminology.js"
  );
  const { buildQualificationRows } = await import(
    "../portal-frontend/src/components/pipeline/pipelineUtils.js"
  );
  const ui = getBusinessTerminology({ businessType: "home_renovation" });
  const lead = {
    treatment_interest: "Kitchen Cabinets",
    branch_name: "KL Sales",
    estimated_value: "18000",
    temperature: "hot",
    owner_username: "alice",
    next_follow_up_at: "2026-09-10T02:00:00.000Z",
    source: "Meta Ad",
  };
  const activities = [
    {
      metadata: {
        outcome: "booking_ready",
        nextStep: "site_visit",
      },
    },
    {
      metadata: {
        outcome: "lead_score",
        projectLocation: "Wrong scoring metadata",
      },
    },
    {
      metadata: {
        outcome: "booking_ready",
        projectLocation: "Cheras",
        projectSummary: "Condo kitchen cabinets; customer has a floor plan.",
        appointmentPreference: "Saturday afternoon",
        nextStep: "quotation_discussion",
      },
    },
  ];

  const rows = buildQualificationRows(ui.qualificationView, lead, activities);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  assert.equal(ui.leadLocationLabel, "Sales location");
  assert.equal(byKey.serviceInterest, "Kitchen Cabinets");
  assert.equal(byKey.projectLocation, "Cheras");
  assert.equal(byKey.projectSummary, "Condo kitchen cabinets; customer has a floor plan.");
  assert.equal(byKey.nextStep, "Site visit");
  assert.equal(byKey.siteVisitTiming, "Saturday afternoon");
  assert.equal(byKey.temperature, "Hot");
  assert.equal(byKey.owner, "alice");
  assert.equal(byKey.source, "Meta Ad");
  assert.notEqual(byKey.projectLocation, lead.branch_name);
  assert.match(byKey.estimatedValue, /RM/);
});

test("clinic drawer profile keeps appointment stage linkage while renovation does not inherit it", async () => {
  const { getBusinessTerminology } = await import(
    "../portal-frontend/src/utils/businessTerminology.js"
  );
  const clinic = getBusinessTerminology({ businessType: "aesthetic_clinic" });
  const renovation = getBusinessTerminology({ businessType: "home_renovation" });
  const generic = getBusinessTerminology({ businessType: "generic" });

  assert.equal(clinic.serviceInterestLabel, "Treatment interest");
  assert.equal(clinic.leadLocationLabel, "Branch");
  assert.equal(clinic.conversionStatusLabel, "Appointment status");
  assert.deepEqual(clinic.conversionStageKeys, {
    set: "appointment_set",
    visited: "visited",
  });
  assert.equal(clinic.qualificationView, null);

  assert.deepEqual(renovation.conversionStageKeys, {});
  assert.equal(renovation.qualificationView.title, "Project qualification");
  assert.equal(generic.qualificationView, null);
});

test("config load reconciles industry defaults before server backfill and LeadDrawer stays profile-driven", () => {
  const root = path.join(__dirname, "..");
  const configRepo = fs.readFileSync(path.join(root, "src/db/configRepo.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "src/server.js"), "utf8");
  const drawer = fs.readFileSync(
    path.join(root, "portal-frontend/src/components/pipeline/LeadDrawer.jsx"),
    "utf8"
  );

  assert.match(configRepo, /ensureIndustryPipelineDefaults/);
  assert.ok(
    server.indexOf("await configRepo.loadConfig()") <
      server.indexOf("await pipelineRepo.backfillLeadsForExistingContacts()")
  );
  assert.match(drawer, /ui\.qualificationView/);
  assert.match(drawer, /ui\.conversionStageKeys/);
  assert.match(drawer, /ui\.leadLocationLabel/);
  assert.doesNotMatch(drawer, /businessType\s*===\s*["']home_renovation["']/);
});
