/**
 * Backup safety-net for flagging conversations that need a human.
 *
 * The primary signal is the AI's structured conversation outcome. Legacy
 * NEEDS_HUMAN / BOOKING_READY markers remain supported during rollout, but
 * this keyword layer is deliberately independent so urgent/human-request
 * messages are still protected if the AI provider fails.
 *
 * Keep patterns high-precision. This is not an intent classifier; it is a
 * defense-in-depth stop for clear English, Bahasa Malaysia and Chinese cases.
 */

const TRIGGER_PATTERNS = [
  // English: explicit human request / complaint / urgent safety language.
  // Avoid broad matches such as plain "side effects" or "in pain" because the
  // deterministic layer now causes a real Staff-mode handoff; normal questions
  // like "what are the side effects?" and "will I be in pain?" should stay AI.
  /\bspeak (to|with) (a |an )?(human|person|staff|someone|agent)\b/i,
  /\btalk (to|with) (a |an )?(human|person|staff|someone|agent)\b/i,
  /\breal (person|human)\b/i,
  /\b(human|staff) (please|pls)\b/i,
  /\bcomplain(t|ing)?\b/i,
  /\brefund\b/i,
  /\bemergency\b/i,
  /\burgent(ly)?\b/i,
  /\b(?:i'?m|i am) allergic\b|\bi have (?:an )?allerg(?:y|ies)\b|\ballergic reaction\b/i,
  /\b(?:i'?m|i am) (?:having|experiencing) (?:a |some )?side effects?\b/i,
  /\bside effects? (?:after|since)\b|\badverse reaction\b|\bbad reaction\b/i,
  /\b(?:i'?m|i am) in pain\b|\bhurts a lot\b|\bsevere pain\b|\bgetting worse\b/i,
  /\blodge (a )?complaint\b/i,
  /\bmanager\b/i,
  /\blawyer\b|\blegal action\b/i,

  // Bahasa Malaysia / common Malaysian chat phrasing. Avoid matching a normal
  // pre-treatment question such as "sakit sangat ke?" as though it were an
  // active severe-pain report.
  /\b(nak|mahu) (cakap|bercakap) (dengan )?(staff|orang|manusia|agent|ejen)\b/i,
  /\b(cakap|sambung) (dengan )?(staff|orang sebenar|agent|ejen)\b/i,
  /\brefund( duit)?\b|\bpulangkan duit\b/i,
  /\b(aduan|buat aduan|nak complain)\b/i,
  /\b(terlalu sakit|sakit teruk|makin sakit|semakin sakit|sakit tak tahan)\b/i,
  /\bsakit sangat\b(?!\s*(?:ke|tak|kah|\?))/i,
  /\b(sesak nafas|susah bernafas|tak boleh bernafas)\b/i,
  /\b(reaksi alergi|alahan teruk|bengkak teruk)\b/i,
  /\b(kecemasan|darurat)\b/i,

  // Simplified/traditional Chinese phrases common in clinic chat. Plain
  // "很痛吗?" / "非常痛吗?" questions are excluded while actual severe or
  // worsening pain reports still trigger the safety backstop.
  /(我要|想找|帮我找|转)(真人|人工|客服|工作人员|职员|職員)/u,
  /(真人客服|人工客服|转人工|轉人工|找经理|找經理)/u,
  /(投诉|投訴|我要投诉|我要投訴|退款|退钱|退錢)/u,
  /(呼吸困难|呼吸困難|喘不过气|喘不過氣|不能呼吸)/u,
  /(过敏反应|過敏反應|严重过敏|嚴重過敏)/u,
  /(剧痛|劇痛|痛得受不了|痛到受不了|越来越痛|越來越痛)/u,
  /(很痛|非常痛)(?!吗|嗎|么|呢|\?|？)/u,
  /(越来越严重|越來越嚴重|越来越肿|越來越腫)/u,
];

const NEEDS_HUMAN_MARKER = "[[NEEDS_HUMAN]]";
const BOOKING_READY_MARKER = "[[BOOKING_READY]]";
const AI_OUTCOME_MARKERS = [NEEDS_HUMAN_MARKER, BOOKING_READY_MARKER];

function checkKeywordTriggers(text) {
  if (!text) return null;
  for (const pattern of TRIGGER_PATTERNS) {
    if (pattern.test(text)) {
      return "Message may need human attention (auto-detected safety/handoff phrase).";
    }
  }
  return null;
}

function stripInternalOutcomeMarkers(text) {
  let cleaned = String(text ?? "");
  for (const marker of AI_OUTCOME_MARKERS) {
    cleaned = cleaned.split(marker).join("");
  }
  return cleaned.trim();
}

/**
 * Legacy marker parser kept for backwards compatibility while providers move
 * to structured JSON. Markers only grant side effects at the start; misplaced
 * control text is stripped from the patient-visible reply without authority.
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

  if (flagged) bookingReady = false;

  return {
    text: stripInternalOutcomeMarkers(text),
    flagged,
    bookingReady,
  };
}

function extractHandoffSignal(reply) {
  const { text, flagged } = extractAiOutcomeSignals(reply);
  return { text, flagged };
}

module.exports = {
  TRIGGER_PATTERNS,
  checkKeywordTriggers,
  extractAiOutcomeSignals,
  extractHandoffSignal,
  stripInternalOutcomeMarkers,
  NEEDS_HUMAN_MARKER,
  BOOKING_READY_MARKER,
};