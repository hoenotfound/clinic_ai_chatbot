const clinicConfig = require("../config/clinicConfig");
const { getConversionProfile } = require("../config/conversionProfiles");
const {
  extractAiOutcomeSignals,
  stripInternalOutcomeMarkers,
} = require("./attentionTriggers");

const VALID_OUTCOMES = new Set(["normal", "needs_human", "booking_ready"]);
const VALID_PROJECT_NEXT_STEPS = new Set(["site_visit", "quotation_discussion"]);
const MAX_METADATA_LENGTH = 240;

function conversionProfile() {
  return getConversionProfile(clinicConfig);
}

function cleanOptionalText(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripInternalOutcomeMarkers(value).trim();
  return cleaned ? cleaned.slice(0, MAX_METADATA_LENGTH) : null;
}

function cleanNextStep(value) {
  const cleaned = cleanOptionalText(value);
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase().replace(/[\s-]+/g, "_");
  return VALID_PROJECT_NEXT_STEPS.has(normalized) ? normalized : null;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalConfiguredName(value, items) {
  const cleaned = cleanOptionalText(value);
  if (!cleaned) return null;
  const target = normalizeName(cleaned);
  const match = (items || []).find(
    (item) => normalizeName(item?.name) === target
  );
  return match ? String(match.name).trim() : null;
}

function canonicalConfiguredService(
  value,
  services = clinicConfig.services,
  aliases = clinicConfig.serviceAliases
) {
  const direct = canonicalConfiguredName(value, services);
  if (direct) return direct;

  const cleaned = cleanOptionalText(value);
  if (!cleaned) return null;
  const target = normalizeName(cleaned);
  if (!target) return null;

  // Accept only configured aliases whose official target also resolves to a
  // currently configured service. Deduplicate identical targets but fail closed
  // if bad configuration makes one alias point to multiple canonical services.
  const resolved = [
    ...new Set(
      (aliases || [])
        .filter((alias) => normalizeName(alias?.alias) === target)
        .map((alias) => canonicalConfiguredName(alias?.officialService, services))
        .filter(Boolean)
    ),
  ];

  return resolved.length === 1 ? resolved[0] : null;
}

function configuredBranchAliases(branch) {
  const canonical = String(branch?.name || "").trim();
  if (!canonical) return new Set();

  const primaryPart = canonical.split(",")[0].trim();
  const normalizedFull = normalizeName(canonical);
  const normalizedPrimary = normalizeName(primaryPart);
  const primaryWords = normalizedPrimary.split(" ").filter(Boolean);
  const initials = primaryWords.length >= 2
    ? primaryWords.map((word) => word[0]).join("")
    : "";

  return new Set(
    [normalizedFull, normalizedPrimary, initials.length >= 2 ? initials : null]
      .filter(Boolean)
  );
}

function canonicalConfiguredBranch(value, branches = clinicConfig.branches) {
  const cleaned = cleanOptionalText(value);
  if (!cleaned) return null;
  const target = normalizeName(cleaned);
  if (!target) return null;

  const matches = (branches || []).filter((branch) =>
    configuredBranchAliases(branch).has(target)
  );
  return matches.length === 1 ? String(matches[0].name).trim() : null;
}

function invalidResponse(message) {
  const err = new Error(message);
  err.code = "INVALID_AI_RESPONSE";
  return err;
}

function stripJsonFence(value) {
  const text = String(value || "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

function looksLikeStructuredReply(value) {
  const text = String(value || "").trim();
  return text.startsWith("{") || /^```(?:json)?\s*\{/i.test(text);
}

function emptyDetails() {
  return {
    branch: null,
    treatment: null,
    appointmentPreference: null,
  };
}

function requiredProjectFields(conversion, nextStep) {
  const requirements = conversion?.requirements;
  if (!requirements || typeof requirements !== "object") return [];
  const fields = requirements[nextStep];
  return Array.isArray(fields) ? fields : [];
}

function parseStructuredReply(raw) {
  const candidate = stripJsonFence(raw);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    if (looksLikeStructuredReply(raw)) {
      const invalid = invalidResponse("AI returned malformed structured JSON.");
      invalid.cause = err;
      throw invalid;
    }
    return null;
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw invalidResponse("AI structured response must be a JSON object.");
  }

  const reply = typeof parsed.reply === "string"
    ? stripInternalOutcomeMarkers(parsed.reply).trim()
    : "";
  const outcome = typeof parsed.outcome === "string"
    ? parsed.outcome.trim().toLowerCase()
    : "";

  if (!reply || !VALID_OUTCOMES.has(outcome)) {
    throw invalidResponse("AI structured response is missing a valid reply/outcome.");
  }

  const conversion = conversionProfile();

  // booking_ready remains the wire-level compatibility outcome, but whether it
  // is executable and which metadata it requires now comes from the active
  // industry's conversion contract.
  if (outcome === "booking_ready" && !conversion.enabled) {
    return {
      text: reply,
      flagged: false,
      bookingReady: false,
      outcome: "normal",
      structured: true,
      details: emptyDetails(),
    };
  }

  const branch = canonicalConfiguredBranch(parsed.branch);
  const treatment = parsed.treatment == null
    ? null
    : canonicalConfiguredService(parsed.treatment);
  const appointmentPreference = cleanOptionalText(parsed.appointmentPreference);
  const isProjectMode = conversion.mode === "project";

  // Project-only fields must never escape into appointment-mode metadata even
  // when a model accidentally fills optional JSON fields that do not belong to
  // the active industry. This prevents false "changed booking" refreshes for
  // existing clinic deployments.
  const projectLocation = isProjectMode
    ? cleanOptionalText(parsed.projectLocation)
    : null;
  const projectSummary = isProjectMode
    ? cleanOptionalText(parsed.projectSummary)
    : null;
  const nextStep = isProjectMode
    ? cleanNextStep(parsed.nextStep)
    : null;

  if (outcome === "booking_ready" && conversion.mode === "appointment") {
    // A clinic Booking Ready response is executable, so do not silently
    // downgrade malformed branch/time metadata while still showing a model
    // reply that tells the patient staff will confirm. Reject it so the AI
    // orchestrator can retry another provider/key and eventually fail safe.
    if (!branch || !appointmentPreference) {
      throw invalidResponse(
        "AI booking_ready response did not contain a valid configured branch and appointment preference."
      );
    }
  }

  if (outcome === "booking_ready" && isProjectMode) {
    // Project conversion readiness is driven by the active profile's contract.
    // Canonical service matching is intentionally part of this validation so an
    // unsupported/hallucinated service cannot execute a staff-facing outcome.
    if (!nextStep) {
      throw invalidResponse(
        "AI booking_ready response did not contain a valid renovation next step."
      );
    }

    const projectDetails = {
      treatment,
      projectLocation,
      projectSummary,
      appointmentPreference,
      nextStep,
    };
    const missingFields = requiredProjectFields(conversion, nextStep)
      .filter((field) => !projectDetails[field]);

    if (missingFields.length) {
      throw invalidResponse(
        `AI booking_ready response is missing required ${nextStep} fields: ${missingFields.join(", ")}.`
      );
    }
  }

  const details = {
    branch,
    treatment,
    appointmentPreference,
  };
  if (isProjectMode && projectLocation) details.projectLocation = projectLocation;
  if (isProjectMode && projectSummary) details.projectSummary = projectSummary;
  if (isProjectMode && nextStep) details.nextStep = nextStep;

  return {
    text: reply,
    flagged: outcome === "needs_human",
    bookingReady: outcome === "booking_ready",
    outcome,
    structured: true,
    details,
  };
}

function parseAiReplyResult(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    const err = new Error("AI returned an empty reply.");
    err.code = "EMPTY_AI_RESPONSE";
    throw err;
  }

  const structured = parseStructuredReply(raw);
  if (structured) return structured;

  // Backward-compatible rollout path. Legacy marker-based booking readiness is
  // safe only for the existing appointment contract because it carries no
  // structured project metadata. Renovation must use the JSON contract above.
  const legacy = extractAiOutcomeSignals(raw);
  const conversion = conversionProfile();
  const allowLegacyBookingReady = conversion.enabled && conversion.mode === "appointment";
  const bookingReady = allowLegacyBookingReady && legacy.bookingReady;
  return {
    ...legacy,
    bookingReady,
    outcome: legacy.flagged
      ? "needs_human"
      : bookingReady
        ? "booking_ready"
        : "normal",
    structured: false,
    details: emptyDetails(),
  };
}

module.exports = {
  VALID_OUTCOMES,
  VALID_PROJECT_NEXT_STEPS,
  canonicalConfiguredBranch,
  canonicalConfiguredName,
  canonicalConfiguredService,
  configuredBranchAliases,
  parseAiReplyResult,
  parseStructuredReply,
};
