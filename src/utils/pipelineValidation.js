const TEMPERATURES = new Set(["hot", "warm", "cold"]);
const APPOINTMENT_STATUSES = new Set(["none", "set", "reschedule", "cancelled", "visited"]);
const MARKETING_CONSENT = new Set(["unknown", "opted_in", "opted_out"]);
const STAGE_TYPES = new Set(["open", "won", "lost"]);

class PipelineValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PipelineValidationError";
    this.status = 400;
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new PipelineValidationError(`${label} is invalid.`);
  }
  return parsed;
}

function optionalString(value, label, maxLength = 200) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new PipelineValidationError(`${label} is invalid.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new PipelineValidationError(`${label} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

function optionalDate(value, label) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new PipelineValidationError(`${label} is invalid.`);
  return date.toISOString();
}

function normalizeLeadPayload(body, { partial = false } = {}) {
  const source = body || {};
  const normalized = {};

  if (!partial || Object.hasOwn(source, "contactId")) {
    normalized.contactId = positiveInteger(source.contactId, "Contact");
  }
  if (Object.hasOwn(source, "stageId")) normalized.stageId = positiveInteger(source.stageId, "Stage");

  if (Object.hasOwn(source, "temperature")) {
    if (!TEMPERATURES.has(source.temperature)) {
      throw new PipelineValidationError("Lead temperature is invalid.");
    }
    normalized.temperature = source.temperature;
  }
  if (Object.hasOwn(source, "temperatureLocked")) {
    if (typeof source.temperatureLocked !== "boolean") {
      throw new PipelineValidationError("Temperature automation setting is invalid.");
    }
    normalized.temperatureLocked = source.temperatureLocked;
  }
  if (Object.hasOwn(source, "appointmentStatus")) {
    if (!APPOINTMENT_STATUSES.has(source.appointmentStatus)) {
      throw new PipelineValidationError("Appointment status is invalid.");
    }
    normalized.appointmentStatus = source.appointmentStatus;
  }
  if (Object.hasOwn(source, "marketingConsent")) {
    if (!MARKETING_CONSENT.has(source.marketingConsent)) {
      throw new PipelineValidationError("Marketing consent is invalid.");
    }
    normalized.marketingConsent = source.marketingConsent;
  }

  const stringFields = [
    ["branchName", "Branch", 160],
    ["ownerUsername", "Owner", 120],
    ["treatmentInterest", "Treatment interest", 200],
    ["source", "Lead source", 120],
    ["campaignName", "Campaign", 200],
    ["lostReason", "Lost reason", 300],
    ["notes", "Notes", 3000],
  ];
  for (const [key, label, maxLength] of stringFields) {
    if (Object.hasOwn(source, key)) {
      normalized[key] = optionalString(source[key], label, maxLength);
    }
  }

  for (const [key, label] of [
    ["appointmentAt", "Appointment date"],
    ["nextFollowUpAt", "Follow-up date"],
  ]) {
    if (Object.hasOwn(source, key)) normalized[key] = optionalDate(source[key], label);
  }

  if (Object.hasOwn(source, "estimatedValue")) {
    if (source.estimatedValue == null || source.estimatedValue === "") {
      normalized.estimatedValue = null;
    } else {
      const value = Number(source.estimatedValue);
      if (!Number.isFinite(value) || value < 0 || value > 9999999999.99) {
        throw new PipelineValidationError("Estimated value is invalid.");
      }
      normalized.estimatedValue = Math.round(value * 100) / 100;
    }
  }

  if (partial && Object.keys(normalized).length === 0) {
    throw new PipelineValidationError("No lead changes were provided.");
  }
  return normalized;
}

function normalizeStagePayload(body, { partial = false } = {}) {
  const source = body || {};
  const normalized = {};
  if (!partial || Object.hasOwn(source, "name")) {
    const name = optionalString(source.name, "Stage name", 80);
    if (!name) throw new PipelineValidationError("Stage name is required.");
    normalized.name = name;
  }
  if (!partial || Object.hasOwn(source, "color")) {
    const color = source.color || "#2f6f62";
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new PipelineValidationError("Stage colour is invalid.");
    }
    normalized.color = color.toLowerCase();
  }
  if (!partial || Object.hasOwn(source, "stageType")) {
    const stageType = source.stageType || "open";
    if (!STAGE_TYPES.has(stageType)) throw new PipelineValidationError("Stage type is invalid.");
    normalized.stageType = stageType;
  }
  if (partial && Object.keys(normalized).length === 0) {
    throw new PipelineValidationError("No stage changes were provided.");
  }
  return normalized;
}

function normalizeStageOrder(body) {
  if (!Array.isArray(body?.stageIds) || body.stageIds.length === 0) {
    throw new PipelineValidationError("Stage order is required.");
  }
  const stageIds = body.stageIds.map((id) => positiveInteger(id, "Stage"));
  if (new Set(stageIds).size !== stageIds.length) {
    throw new PipelineValidationError("Stage order contains duplicates.");
  }
  return stageIds;
}

module.exports = {
  PipelineValidationError,
  normalizeLeadPayload,
  normalizeStagePayload,
  normalizeStageOrder,
};
