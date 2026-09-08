const clinicConfig = require("../config/clinicConfig");
const { getPipelineProfile } = require("../config/pipelineProfiles");

const SYSTEM_KEY_PATTERN = /^[a-z0-9_]+$/;

function safeSystemKey(value, label) {
  const key = String(value || "");
  if (!SYSTEM_KEY_PATTERN.test(key)) {
    throw new TypeError(`Invalid analytics ${label} system key.`);
  }
  return key;
}

function getAnalyticsPipelineProfile(config = clinicConfig) {
  const profile = getPipelineProfile(config);
  const analytics = profile.analytics || {};
  return {
    businessType: profile.businessType,
    qualificationSystemKey: analytics.qualificationSystemKey || null,
    primarySystemKey: safeSystemKey(analytics.primarySystemKey, "primary"),
    secondarySystemKey: safeSystemKey(analytics.secondarySystemKey, "secondary"),
    appointmentStatusFallback: analytics.appointmentStatusFallback === true,
    funnelLabels: { ...(analytics.funnelLabels || {}) },
  };
}

function stageTimeSql(systemKey, alias) {
  if (!systemKey) return `NULL::timestamptz AS ${alias}`;
  return `MIN(h.created_at) FILTER (WHERE stage.system_key = '${safeSystemKey(systemKey, alias)}') AS ${alias}`;
}

function milestoneTimesCte(profile = getAnalyticsPipelineProfile({ businessType: "aesthetic_clinic" })) {
  const qualificationReached = profile.qualificationSystemKey
    ? "mt.qualification_at IS NOT NULL OR"
    : "";
  const statusPrimary = profile.appointmentStatusFallback
    ? "OR j.appointment_status IN ('set', 'visited')"
    : "";
  const statusSecondary = profile.appointmentStatusFallback
    ? "OR j.appointment_status = 'visited'"
    : "";
  const reachedQualification = profile.qualificationSystemKey
    ? `(
      mt.qualification_at IS NOT NULL
      OR mt.primary_at IS NOT NULL
      OR mt.secondary_at IS NOT NULL
      OR mt.won_at IS NOT NULL
    )`
    : "false";

  return `
, milestone_times AS (
  SELECT
    h.lead_id,
    ${stageTimeSql("contacted", "contacted_at")},
    ${stageTimeSql(profile.qualificationSystemKey, "qualification_at")},
    ${stageTimeSql(profile.primarySystemKey, "primary_at")},
    ${stageTimeSql(profile.secondarySystemKey, "secondary_at")},
    MIN(h.created_at) FILTER (WHERE stage.stage_type = 'won') AS won_at,
    MIN(h.created_at) FILTER (WHERE stage.stage_type = 'lost') AS lost_at
  FROM lead_stage_history h
  JOIN pipeline_stages stage ON stage.id = h.to_stage_id
  GROUP BY h.lead_id
),
journeys_with_milestones AS (
  SELECT
    j.*,
    mt.contacted_at,
    mt.qualification_at,
    mt.primary_at AS milestone_appointment_at,
    mt.secondary_at AS visited_at,
    mt.won_at,
    mt.lost_at,
    (
      mt.contacted_at IS NOT NULL
      OR ${qualificationReached}
      mt.primary_at IS NOT NULL
      OR mt.secondary_at IS NOT NULL
      OR mt.won_at IS NOT NULL
      ${statusPrimary}
    ) AS reached_contacted,
    ${reachedQualification} AS reached_qualification,
    (
      mt.primary_at IS NOT NULL
      OR mt.secondary_at IS NOT NULL
      OR mt.won_at IS NOT NULL
      ${statusPrimary}
    ) AS reached_appointment,
    (
      mt.secondary_at IS NOT NULL
      OR mt.won_at IS NOT NULL
      ${statusSecondary}
    ) AS reached_visited,
    (mt.won_at IS NOT NULL OR j.current_stage_type = 'won') AS reached_won,
    (mt.lost_at IS NOT NULL OR j.current_stage_type = 'lost') AS reached_lost
  FROM journeys j
  LEFT JOIN milestone_times mt ON mt.lead_id = j.id
)
`;
}

function buildFunnelStages(cohort, profile = getAnalyticsPipelineProfile({ businessType: "aesthetic_clinic" })) {
  const labels = profile.funnelLabels || {};
  return [
    ["New Leads", cohort.newLeads],
    [labels.contacted || "Contacted", cohort.contacted],
    ...(profile.qualificationSystemKey
      ? [[labels.qualification || "Qualified", cohort.qualified]]
      : []),
    [labels.primary || "Qualified", cohort.appointments],
    [labels.secondary || "Decision", cohort.visits],
    [labels.won || "Won", cohort.won],
  ];
}

module.exports = {
  buildFunnelStages,
  getAnalyticsPipelineProfile,
  milestoneTimesCte,
  safeSystemKey,
};
