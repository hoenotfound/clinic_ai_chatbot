const {
  DEFAULT_BUSINESS_TYPE,
  SUPPORTED_BUSINESS_TYPES,
} = require("./industryProfiles");

const BUSINESS_PROFILE_OPTIONS = Object.freeze([
  Object.freeze({
    value: "aesthetic_clinic",
    label: "Aesthetic Clinic",
    description: "Clinic consultation, appointment and treatment workflow.",
  }),
  Object.freeze({
    value: "home_renovation",
    label: "Home Renovation",
    description: "Renovation, cabinetry, carpentry, quotation and site-visit workflow.",
  }),
  Object.freeze({
    value: "generic",
    label: "General Business",
    description: "Conservative neutral profile without industry-specific conversion automation.",
  }),
]);

function hasExplicitInitialBusinessType(env = process.env) {
  return Boolean(String(env.INITIAL_BUSINESS_TYPE || env.BUSINESS_TYPE || "").trim());
}

function createSeedIndustrySetup(env = process.env, now = new Date()) {
  const explicit = hasExplicitInitialBusinessType(env);
  return {
    selectable: !explicit,
    locked: explicit,
    source: explicit ? "environment" : "default",
    selectedAt: explicit ? now.toISOString() : null,
    lockReason: explicit ? "environment_selected" : null,
  };
}

function normalizeIndustrySetup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    // Databases that pre-date the atomic selector are established clients.
    // Fail closed instead of making an old production deployment switchable.
    return {
      selectable: false,
      locked: true,
      source: "legacy",
      selectedAt: null,
      lockReason: "legacy_existing_deployment",
    };
  }

  return {
    selectable: value.selectable === true,
    locked: value.locked === true,
    source: String(value.source || "unknown"),
    selectedAt: value.selectedAt || null,
    lockReason: value.lockReason || null,
  };
}

function lockIndustrySetup(value, {
  source = "setup_status",
  reason = "profile_confirmed",
  now = new Date(),
} = {}) {
  const current = normalizeIndustrySetup(value);
  return {
    ...current,
    selectable: false,
    locked: true,
    source,
    selectedAt: current.selectedAt || now.toISOString(),
    lockReason: reason,
  };
}

function getBusinessProfileOptions() {
  return BUSINESS_PROFILE_OPTIONS
    .filter((option) => SUPPORTED_BUSINESS_TYPES.includes(option.value))
    .map((option) => ({
      ...option,
      default: option.value === DEFAULT_BUSINESS_TYPE,
    }));
}

module.exports = {
  BUSINESS_PROFILE_OPTIONS,
  createSeedIndustrySetup,
  getBusinessProfileOptions,
  hasExplicitInitialBusinessType,
  lockIndustrySetup,
  normalizeIndustrySetup,
};
