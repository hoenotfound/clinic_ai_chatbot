const clinicConfig = require("../config/clinicConfig");
const {
  extractAiOutcomeSignals,
  stripInternalOutcomeMarkers,
} = require("./attentionTriggers");

const VALID_OUTCOMES = new Set(["normal", "needs_human", "booking_ready"]);
const MAX_METADATA_LENGTH = 240;

function cleanOptionalText(value) {
  if (typeof value !== "string") return null;
  const cleaned = stripInternalOutcomeMarkers(value).trim();
  return cleaned ? cleaned.slice(0, MAX_METADATA_LENGTH) : null;
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

  const branch = canonicalConfiguredBranch(parsed.branch);
  const treatment = parsed.treatment == null
    ? null
    : canonicalConfiguredName(parsed.treatment, clinicConfig.services);
  const appointmentPreference = cleanOptionalText(parsed.appointmentPreference);

  // A structured Booking Ready response is an executable business outcome, so
  // don't silently downgrade malformed metadata while still showing the model's
  // "the team will confirm" reply. Reject it and let the AI orchestrator retry
  // another key/provider; if all attempts fail, the normal safe staff fallback
  // takes over. Common unambiguous clinic shorthand such as PJ/SP is resolved
  // above before this check.
  if (outcome === "booking_ready" && (!branch || !appointmentPreference)) {
    throw invalidResponse(
      "AI booking_ready response did not contain a valid configured branch and appointment preference."
    );
  }

  return {
    text: reply,
    flagged: outcome === "needs_human",
    bookingReady: outcome === "booking_ready",
    outcome,
    structured: true,
    details: {
      branch,
      treatment,
      appointmentPreference,
    },
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

  // Backward-compatible rollout path. If a provider/model ignores the JSON
  // contract but follows the legacy marker protocol, the existing outcomes
  // remain safe and patient-visible markers are still removed.
  const legacy = extractAiOutcomeSignals(raw);
  return {
    ...legacy,
    outcome: legacy.flagged
      ? "needs_human"
      : legacy.bookingReady
        ? "booking_ready"
        : "normal",
    structured: false,
    details: {
      branch: null,
      treatment: null,
      appointmentPreference: null,
    },
  };
}

module.exports = {
  VALID_OUTCOMES,
  canonicalConfiguredBranch,
  canonicalConfiguredName,
  configuredBranchAliases,
  parseAiReplyResult,
  parseStructuredReply,
};