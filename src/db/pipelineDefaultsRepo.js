const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const {
  CLINIC_DEFAULT_STAGES,
  getPipelineProfile,
} = require("../config/pipelineProfiles");

function comparableStage(stage) {
  return {
    name: String(stage?.name || ""),
    sortOrder: Number(stage?.sort_order ?? stage?.sortOrder),
    color: String(stage?.color || ""),
    stageType: String(stage?.stage_type ?? stage?.stageType ?? ""),
    systemKey: stage?.system_key ?? stage?.systemKey ?? null,
  };
}

function stagesExactlyMatch(existingStages, expectedStages) {
  if (!Array.isArray(existingStages) || !Array.isArray(expectedStages)) return false;
  if (existingStages.length !== expectedStages.length) return false;
  return existingStages.every((stage, index) => {
    const existing = comparableStage(stage);
    const expected = comparableStage(expectedStages[index]);
    return (
      existing.name === expected.name &&
      existing.sortOrder === expected.sortOrder &&
      existing.color === expected.color &&
      existing.stageType === expected.stageType &&
      existing.systemKey === expected.systemKey
    );
  });
}

async function insertDefaultStages(client, stages) {
  for (const stage of stages) {
    await client.query(
      `INSERT INTO pipeline_stages (name, sort_order, color, stage_type, system_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [stage.name, stage.sortOrder, stage.color, stage.stageType, stage.systemKey]
    );
  }
}

async function ensureIndustryPipelineDefaults(config = clinicConfig, database = pool) {
  const profile = getPipelineProfile(config);
  const client = await database.connect();
  let inTransaction = false;

  try {
    // Mature client databases can never be auto-reseeded. Avoid taking strong
    // startup locks on their live Pipeline at all. A zero-lead result is only a
    // preflight hint; it is re-checked after the locks below before any stage
    // can be replaced, so concurrent lead creation remains safe.
    const preflightLeadResult = await client.query(
      "SELECT EXISTS (SELECT 1 FROM leads LIMIT 1) AS has_leads"
    );
    if (preflightLeadResult.rows?.[0]?.has_leads === true) {
      return { changed: false, reason: "pipeline_in_use", businessType: profile.businessType };
    }

    await client.query("BEGIN");
    inTransaction = true;

    // Startup can overlap a previous Render instance that is still serving
    // traffic. Lock stages first so an old instance cannot read a stage id that
    // is about to be replaced, then block lead writes while the zero-lead safety
    // check and any replacement happen in the same transaction. These table
    // locks also serialize two new instances starting at the same time without
    // requiring older code to participate in an advisory-lock convention.
    await client.query("LOCK TABLE pipeline_stages IN ACCESS EXCLUSIVE MODE");
    await client.query("LOCK TABLE leads IN SHARE ROW EXCLUSIVE MODE");

    const stageResult = await client.query(
      `SELECT id, name, sort_order, color, stage_type, system_key
       FROM pipeline_stages
       ORDER BY sort_order ASC, id ASC`
    );
    const leadResult = await client.query("SELECT COUNT(*)::int AS count FROM leads");

    const existingStages = stageResult.rows || [];
    const leadCount = Number(leadResult.rows?.[0]?.count || 0);

    if (leadCount > 0) {
      await client.query("COMMIT");
      inTransaction = false;
      return { changed: false, reason: "pipeline_in_use", businessType: profile.businessType };
    }

    if (stagesExactlyMatch(existingStages, profile.defaultStages)) {
      await client.query("COMMIT");
      inTransaction = false;
      return { changed: false, reason: "already_correct", businessType: profile.businessType };
    }

    const isEmpty = existingStages.length === 0;
    const isUntouchedLegacyClinicDefault = stagesExactlyMatch(
      existingStages,
      CLINIC_DEFAULT_STAGES
    );

    if (!isEmpty && !isUntouchedLegacyClinicDefault) {
      await client.query("COMMIT");
      inTransaction = false;
      return { changed: false, reason: "customized_pipeline", businessType: profile.businessType };
    }

    if (!isEmpty) {
      await client.query("DELETE FROM pipeline_stages");
    }
    await insertDefaultStages(client, profile.defaultStages);
    await client.query("COMMIT");
    inTransaction = false;

    return {
      changed: true,
      reason: isEmpty ? "seeded_empty_pipeline" : "replaced_legacy_default",
      businessType: profile.businessType,
      stageCount: profile.defaultStages.length,
    };
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  comparableStage,
  ensureIndustryPipelineDefaults,
  stagesExactlyMatch,
};
