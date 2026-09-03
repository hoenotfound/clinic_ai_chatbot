/**
 * Backup safety-net for flagging conversations that need a human.
 *
 * The primary signal is the AI itself: systemPrompt.js instructs it to
 * prefix replies with an internal marker for actionable conversation outcomes.
 * NEEDS_HUMAN is the existing escalation path; BOOKING_READY means the customer
 * has provided enough scheduling preference for staff to confirm availability.
 * Both markers are stripped before the patient ever sees the reply.
 *
 * This keyword check exists for cases the AI signal can't cover:
 *  - the AI call fails/errors and the fallback message goes out instead
 *  - a patient sends something urgent while a staff member already owns
 *    the conversation (mode='human'), so no AI call happens at all
 *  - defense-in-depth, in case the model just doesn't add the marker
 *
 * Keep this list short and high-precision — it only needs to catch clear
 * cases, not do the AI's job.
 */

const TRIGGER_PATTERNS = [
  /\bspeak (to|with) (a |an )?(human|person|staff|someone|agent)\b/i,
  /\btalk (to|with) (a |an )?(human|person|staff|someone|agent)\b/i,
  /\breal (person|human)\b/i,
  /\b(human|staff) (please|pls)\b/i,
  /\bcomplain(t|ing)?\b/i,
  /\brefund\b/i,
  /\bemergency\b/i,
  /\burgent(ly)?\b/i,
  /\ballerg(y|ic|ic reaction)\b/i,
  /\bside effect\b/i,
  /\bin pain\b|\bhurts a lot\b/i,
  /\blodge (a )?complaint\b/i,
  /\bmanager\b/i,
  /\blawyer\b|\blegal action\b/i,
];

const NEEDS_HUMAN_MARKER = "[[NEEDS_HUMAN]]";
const BOOKING_READY_MARKER = "[[BOOKING_READY]]";
const AI_OUTCOME_MARKERS = [NEEDS_HUMAN_MARKER, BOOKING_READY_MARKER];

/**
 * @param {string} text - inbound patient message
 * @returns {string|null} a short reason string if a trigger matched, else null
 */
function checkKeywordTriggers(text) {
  if (!text) return null;
  for (const pattern of TRIGGER_PATTERNS) {
    if (pattern.test(text)) {
      return "Message may need human attention (auto-detected keyword).";
    }
  }
  return null;
}

/**
 * Strips any supported internal outcome markers from the start of an AI reply.
 * Escalation wins if a model ever emits both markers accidentally.
 *
 * @param {string} reply
 * @returns {{ text: string, flagged: boolean, bookingReady: boolean }}
 */
function extractAiOutcomeSignals(reply) {
  if (typeof reply !== "string") {
    return { text: reply, flagged: false, bookingReady: false };
  }

  let text = reply.trim();
  let flagged = false;
  let bookingReady = false;
  let removedMarker = true;

  while (removedMarker) {
    removedMarker = false;
    for (const marker of AI_OUTCOME_MARKERS) {
      if (!text.startsWith(marker)) continue;
      if (marker === NEEDS_HUMAN_MARKER) flagged = true;
      if (marker === BOOKING_READY_MARKER) bookingReady = true;
      text = text.slice(marker.length).trimStart();
      removedMarker = true;
      break;
    }
  }

  // A medical/safety/human escalation is always more important than a sales
  // outcome. Never run booking-ready automation on the same reply.
  if (flagged) bookingReady = false;

  return { text: text.trim(), flagged, bookingReady };
}

/**
 * Backward-compatible helper kept for existing callers/tests that only care
 * about the human-handoff signal.
 */
function extractHandoffSignal(reply) {
  const { text, flagged } = extractAiOutcomeSignals(reply);
  return { text, flagged };
}

module.exports = {
  checkKeywordTriggers,
  extractAiOutcomeSignals,
  extractHandoffSignal,
  NEEDS_HUMAN_MARKER,
  BOOKING_READY_MARKER,
};
