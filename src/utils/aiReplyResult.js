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

function canonicalConfiguredName(value, items) {
  const cleaned = cleanOptionalText(value);
  if (!cleaned) return null;
  const match = (items || []).find(
    (item) => String(item?.name || "").trim().toLowerCase() === cleaned.toLowerCase()
  );
  return match ? String(match.name).trim() : null;
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
      const invalid = new Error("AI returned malformed structured JSON.");
      invalid.code = "INVALID_AI_RESPONSE";
      invalid.cause = err;
      throw invalid;
    }
    return null;
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    const invalid = new Error("AI structured response must be a JSON object.");
    invalid.code = "INVALID_AI_RESPONSE";
    throw invalid;
  }

  const reply = typeof parsed.reply === "string"
    ? stripInternalOutcomeMarkers(parsed.reply).trim()
    : "";
  const outcome = typeof parsed.outcome === "string"
    ? parsed.outcome.trim().toLowerCase()
    : "";

  if (!reply || !VALID_OUTCOMES.has(outcome)) {
    const invalid = new Error("AI structured response is missing a valid reply/outcome.");
    invalid.code = "INVALID_AI_RESPONSE";
    throw invalid;
  }

  // Structured outcomes use canonical config names rather than trusting free
  // model text. An abbreviation such as "PJ" is not enough to authorize a
  // Booking Ready side effect; the model was explicitly instructed to return
  // "Petaling Jaya". This makes the backend fail closed if it doesn't comply.
  const branch = canonicalConfiguredName(parsed.branch, clinicConfig.branches);
  const treatment = parsed.treatment == null
    ? null
    : canonicalConfiguredName(parsed.treatment, clinicConfig.services);
  const appointmentPreference = cleanOptionalText(parsed.appointmentPreference);

  const bookingReady =
    outcome === "booking_ready" && Boolean(branch && appointmentPreference);

  return {
    text: reply,
    flagged: outcome === "needs_human",
    bookingReady,
    outcome: bookingReady ? "booking_ready" : outcome === "booking_ready" ? "normal" : outcome,
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
  canonicalConfiguredName,
  parseAiReplyResult,
  parseStructuredReply,
};