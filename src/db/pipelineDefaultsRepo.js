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

  try {
    await client.query("BEGIN");

    const [stageResult, leadResult] = await Promise.all([
      client.query(
        `SELECT id, name, sort_order, color, stage_type, system_key
         FROM pipeline_stages
         ORDER BY sort_order ASC, id ASC
         FOR UPDATE`
      ),
      client.query("SELECT COUNT(*)::int AS count FROM leads"),
    ]);

    const existingStages = stageResult.rows || [];
    const leadCount = Number(leadResult.rows?.[0]?.count || 0);

    if (leadCount > 0) {
      await client.query("COMMIT");
      return { changed: false, reason: "pipeline_in_use", businessType: profile.businessType };
    }

    if (stagesExactlyMatch(existingStages, profile.defaultStages)) {
      await client.query("COMMIT");
      return { changed: false, reason: "already_correct", businessType: profile.businessType };
    }

    const isEmpty = existingStages.length === 0;
    const isUntouchedLegacyClinicDefault = stagesExactlyMatch(
      existingStages,
      CLINIC_DEFAULT_STAGES
    );

    if (!isEmpty && !isUntouchedLegacyClinicDefault) {
      await client.query("COMMIT");
      return { changed: false, reason: "customized_pipeline", businessType: profile.businessType };
    }

    if (!isEmpty) {
      await client.query("DELETE FROM pipeline_stages");
    }
    await insertDefaultStages(client, profile.defaultStages);
    await client.query("COMMIT");

    return {
      changed: true,
      reason: isEmpty ? "seeded_empty_pipeline" : "replaced_legacy_default",
      businessType: profile.businessType,
      stageCount: profile.defaultStages.length,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
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
