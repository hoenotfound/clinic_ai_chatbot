/**
 * Backup safety-net for flagging conversations that need a human.
 *
 * The primary signal is the AI itself: systemPrompt.js instructs it to
 * prefix its reply with NEEDS_HUMAN_MARKER whenever it uses the clinic's
 * configured handoff message (see clinicConfig.escalation). That's the
 * preferred path because it reuses the clinic's own escalation rules
 * instead of duplicating them here.
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
 * Strips the AI's NEEDS_HUMAN_MARKER prefix off a reply, if present.
 * @param {string} reply
 * @returns {{ text: string, flagged: boolean }}
 */
function extractHandoffSignal(reply) {
  if (typeof reply === "string" && reply.trim().startsWith(NEEDS_HUMAN_MARKER)) {
    return { text: reply.replace(NEEDS_HUMAN_MARKER, "").trim(), flagged: true };
  }
  return { text: reply, flagged: false };
}

module.exports = { checkKeywordTriggers, extractHandoffSignal, NEEDS_HUMAN_MARKER };
