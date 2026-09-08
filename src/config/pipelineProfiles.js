const { normalizeBusinessType } = require("./industryProfiles");

const CLINIC_DEFAULT_STAGES = Object.freeze([
  Object.freeze({ name: "New Lead", sortOrder: 10, color: "#397a6d", stageType: "open", systemKey: "new" }),
  Object.freeze({ name: "Contacted", sortOrder: 20, color: "#3b82a0", stageType: "open", systemKey: "contacted" }),
  Object.freeze({ name: "Appointment Set", sortOrder: 30, color: "#c58b2a", stageType: "open", systemKey: "appointment_set" }),
  Object.freeze({ name: "Visited Clinic", sortOrder: 40, color: "#7c62a3", stageType: "open", systemKey: "visited" }),
  Object.freeze({ name: "Converted / Won", sortOrder: 50, color: "#2f7d4e", stageType: "won", systemKey: "won" }),
  Object.freeze({ name: "Closed / Lost", sortOrder: 60, color: "#a94b3d", stageType: "lost", systemKey: "lost" }),
]);

const RENOVATION_DEFAULT_STAGES = Object.freeze([
  Object.freeze({ name: "New Lead", sortOrder: 10, color: "#397a6d", stageType: "open", systemKey: "new" }),
  Object.freeze({ name: "Contacted", sortOrder: 20, color: "#3b82a0", stageType: "open", systemKey: "contacted" }),
  Object.freeze({ name: "Qualified", sortOrder: 30, color: "#5f7e8c", stageType: "open", systemKey: "qualified" }),
  Object.freeze({ name: "Quotation / Site Visit", sortOrder: 40, color: "#c58b2a", stageType: "open", systemKey: "next_step" }),
  Object.freeze({ name: "Decision", sortOrder: 50, color: "#7c62a3", stageType: "open", systemKey: "decision" }),
  Object.freeze({ name: "Won", sortOrder: 60, color: "#2f7d4e", stageType: "won", systemKey: "won" }),
  Object.freeze({ name: "Lost", sortOrder: 70, color: "#a94b3d", stageType: "lost", systemKey: "lost" }),
]);

const GENERIC_DEFAULT_STAGES = Object.freeze([
  Object.freeze({ name: "New Lead", sortOrder: 10, color: "#397a6d", stageType: "open", systemKey: "new" }),
  Object.freeze({ name: "Contacted", sortOrder: 20, color: "#3b82a0", stageType: "open", systemKey: "contacted" }),
  Object.freeze({ name: "Qualified", sortOrder: 30, color: "#5f7e8c", stageType: "open", systemKey: "qualified" }),
  Object.freeze({ name: "Decision", sortOrder: 40, color: "#7c62a3", stageType: "open", systemKey: "decision" }),
  Object.freeze({ name: "Won", sortOrder: 50, color: "#2f7d4e", stageType: "won", systemKey: "won" }),
  Object.freeze({ name: "Lost", sortOrder: 60, color: "#a94b3d", stageType: "lost", systemKey: "lost" }),
]);

const CLINIC_ANALYTICS = Object.freeze({
  qualificationSystemKey: null,
  primarySystemKey: "appointment_set",
  secondarySystemKey: "visited",
  appointmentStatusFallback: true,
  funnelLabels: Object.freeze({
    contacted: "Contacted",
    qualification: null,
    primary: "Appointment Set",
    secondary: "Visited Clinic",
    won: "Converted / Won",
  }),
});

const RENOVATION_ANALYTICS = Object.freeze({
  qualificationSystemKey: "qualified",
  primarySystemKey: "next_step",
  secondarySystemKey: "decision",
  // Renovation analytics are stage-history based. The legacy appointment_status
  // column is still exposed as staff-facing Next-step status, but it has no
  // reliable milestone timestamp and must not make cohort/performance counts
  // disagree with activity trends and follow-up attribution.
  appointmentStatusFallback: false,
  funnelLabels: Object.freeze({
    contacted: "Contacted",
    qualification: "Qualified",
    primary: "Quotation / Site Visit",
    secondary: "Decision",
    won: "Won",
  }),
});

const GENERIC_ANALYTICS = Object.freeze({
  qualificationSystemKey: null,
  primarySystemKey: "qualified",
  secondarySystemKey: "decision",
  appointmentStatusFallback: false,
  funnelLabels: Object.freeze({
    contacted: "Contacted",
    qualification: null,
    primary: "Qualified",
    secondary: "Decision",
    won: "Won",
  }),
});

const PIPELINE_PROFILES = Object.freeze({
  aesthetic_clinic: Object.freeze({
    defaultStages: CLINIC_DEFAULT_STAGES,
    analytics: CLINIC_ANALYTICS,
  }),
  home_renovation: Object.freeze({
    defaultStages: RENOVATION_DEFAULT_STAGES,
    analytics: RENOVATION_ANALYTICS,
  }),
  generic: Object.freeze({
    defaultStages: GENERIC_DEFAULT_STAGES,
    analytics: GENERIC_ANALYTICS,
  }),
});

function cloneProfile(profile) {
  return {
    defaultStages: profile.defaultStages.map((stage) => ({ ...stage })),
    analytics: {
      ...profile.analytics,
      funnelLabels: { ...profile.analytics.funnelLabels },
    },
  };
}

function resolvePipelineBusinessType(config = {}) {
  const rawType = typeof config === "string" ? config : config?.businessType;
  if (!String(rawType || "").trim()) return "aesthetic_clinic";
  return normalizeBusinessType(rawType) || "generic";
}

function getPipelineProfile(config = {}) {
  const businessType = resolvePipelineBusinessType(config);
  return {
    businessType,
    ...cloneProfile(PIPELINE_PROFILES[businessType] || PIPELINE_PROFILES.generic),
  };
}

module.exports = {
  CLINIC_ANALYTICS,
  CLINIC_DEFAULT_STAGES,
  GENERIC_ANALYTICS,
  GENERIC_DEFAULT_STAGES,
  PIPELINE_PROFILES,
  RENOVATION_ANALYTICS,
  RENOVATION_DEFAULT_STAGES,
  getPipelineProfile,
  resolvePipelineBusinessType,
};
