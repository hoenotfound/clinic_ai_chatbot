const clinicConfig = require("../config/clinicConfig");
const { getConversionProfile } = require("../config/conversionProfiles");
const {
  AI_OUTCOME_MARKERS,
  extractAiOutcomeSignals,
  stripInternalOutcomeMarkers,
} = require("./attentionTriggers");

const VALID_OUTCOMES = new Set(["normal", "needs_human", "booking_ready"]);
const VALID_PROJECT_NEXT_STEPS = new Set(["site_visit", "quotation_discussion"]);
const MAX_METADATA_LENGTH = 240;
const MAX_STAFF_SUMMARY_LENGTH = 600;

function conversionProfile() {
  return getConversionProfile(clinicConfig);
}

function cleanOptionalText(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripInternalOutcomeMarkers(value).trim();
  return cleaned ? cleaned.slice(0, MAX_METADATA_LENGTH) : null;
}

function cleanStaffSummary(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripInternalOutcomeMarkers(value).trim();
  return cleaned ? cleaned.slice(0, MAX_STAFF_SUMMARY_LENGTH) : null;
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
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactName(value) {
  return normalizeName(value).replace(/\s+/g, "");
}

function canonicalConfiguredName(value, items) {
  const cleaned = cleanOptionalText(value);
  if (!cleaned) return null;
  const target = normalizeName(cleaned);
  const exactMatches = (items || []).filter(
    (item) => normalizeName(item?.name) === target
  );
  if (exactMatches.length === 1) {
    return String(exactMatches[0].name).trim();
  }
  if (exactMatches.length > 1) return null;

  // Models sometimes preserve the right canonical words but alter spacing
  // between Latin digits and Chinese text (e.g. "3D小颜术" vs "3D 小颜术").
  // Accept that only when the compact form identifies exactly one service.
  const compactTarget = compactName(cleaned);
  const compactMatches = (items || []).filter(
    (item) => compactName(item?.name) === compactTarget
  );
  return compactMatches.length === 1
    ? String(compactMatches[0].name).trim()
    : null;
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
        .filter(
          (alias) =>
            normalizeName(alias?.alias) === target ||
            compactName(alias?.alias) === compactName(cleaned)
        )
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

function soleConfiguredBranch(branches = clinicConfig.branches) {
  const named = (branches || [])
    .map((branch) => String(branch?.name || "").trim())
    .filter(Boolean);
  return named.length === 1 ? named[0] : null;
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

function startsWithLegacyOutcomeMarker(value) {
  const text = String(value || "").trimStart();
  return AI_OUTCOME_MARKERS.some((marker) => text.startsWith(marker));
}

function containsInternalAiScaffolding(value) {
  const text = String(value || "");
  if (!text) return false;

  return (
    /json\s+construction\s*:/i.test(text)
    || /structured\s+output\s*[-:：]?/i.test(text)
    || /(?:^|[{,\n])\s*["']?(?:priceQuery|packageQuery|promotionOption|appointmentPreference|projectLocation|projectSummary|nextStep|staffSummary)["']?\s*:/m.test(text)
    || /(?:^|[{,\n])\s*["']?outcome["']?\s*:\s*["']?(?:normal|needs_human|booking_ready)\b/im.test(text)
    || /\{\s*["']?reply["']?\s*:[\s\S]{0,1200}["']?outcome["']?\s*:/i.test(text)
  );
}

function assertCustomerFacingReplySafe(value) {
  if (containsInternalAiScaffolding(value)) {
    throw invalidResponse("AI reply contained internal structured-output content.");
  }
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
  const priceQuery = parsed.priceQuery === true;
  const packageQuery = parsed.packageQuery === true;
  const promotionOption = cleanOptionalText(parsed.promotionOption);

  if (!reply || !VALID_OUTCOMES.has(outcome)) {
    throw invalidResponse("AI structured response is missing a valid reply/outcome.");
  }
  assertCustomerFacingReplySafe(reply);

  const conversion = conversionProfile();

  // booking_ready remains the wire-level compatibility outcome, but whether it
  // is executable and which metadata it requires now comes from the active
  // industry's conversion contract.
  if (outcome === "booking_ready" && !conversion.enabled) {
    return {
      text: reply,
      flagged: false,
      bookingReady: false,
      priceQuery,
      packageQuery,
      promotionOption,
      outcome: "normal",
      structured: true,
      details: emptyDetails(),
    };
  }

  const isProjectMode = conversion.mode === "project";
  const providedBranch = cleanOptionalText(parsed.branch);
  const branch = providedBranch
    ? canonicalConfiguredBranch(providedBranch)
    : !isProjectMode && clinicConfig.businessType === "tcm_clinic"
      ? soleConfiguredBranch()
      : null;
  const treatment = parsed.treatment == null
    ? null
    : canonicalConfiguredService(parsed.treatment);
  const appointmentPreference = cleanOptionalText(parsed.appointmentPreference);
  const staffSummary = outcome === "booking_ready"
    ? cleanStaffSummary(parsed.staffSummary)
    : null;

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
  if (staffSummary) details.staffSummary = staffSummary;

  return {
    text: reply,
    flagged: outcome === "needs_human",
    bookingReady: outcome === "booking_ready",
    priceQuery,
    packageQuery,
    promotionOption,
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

  // The production prompt requires structured JSON. Do not treat arbitrary
  // provider prose as customer-safe output, because models can append internal
  // scaffolding such as "JSON Construction" after an otherwise natural reply.
  // Keep only the explicit marker-based legacy contract during rollout.
  if (!startsWithLegacyOutcomeMarker(raw)) {
    throw invalidResponse(
      "AI returned unstructured text instead of the required structured JSON response."
    );
  }

  // Backward-compatible rollout path. Legacy marker-based booking readiness is
  // safe only for the existing appointment contract because it carries no
  // structured project metadata. Renovation must use the JSON contract above.
  const legacy = extractAiOutcomeSignals(raw);
  assertCustomerFacingReplySafe(legacy.text);
  const conversion = conversionProfile();
  const allowLegacyBookingReady = conversion.enabled && conversion.mode === "appointment";
  const bookingReady = allowLegacyBookingReady && legacy.bookingReady;
  return {
    ...legacy,
    bookingReady,
    priceQuery: false,
    packageQuery: false,
    promotionOption: null,
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
  MAX_STAFF_SUMMARY_LENGTH,
  canonicalConfiguredBranch,
  canonicalConfiguredName,
  canonicalConfiguredService,
  configuredBranchAliases,
  soleConfiguredBranch,
  parseAiReplyResult,
  parseStructuredReply,
};
