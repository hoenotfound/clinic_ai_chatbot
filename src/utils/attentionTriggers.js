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
 *
 * Safety phrases live here as the single source of truth. Customer-facing
 * handoff wording imports the urgent detector from this module rather than
 * keeping a second regex list that can drift.
 */

const URGENT_SAFETY_REASON =
  "Urgent safety message requires human attention (auto-detected).";
const HANDOFF_REASON =
  "Message may need human attention (auto-detected safety/handoff phrase).";

const URGENT_SAFETY_PATTERNS = [
  // English
  /\b(emergency|severe pain|getting worse|vision changes?|spreading rash|chest pain)\b/i,
  /\b(can'?t|cannot|hard to|difficulty) breathe\b/i,
  /\b(shortness of breath|trouble breathing)\b/i,
  /\b(blanching|skin (?:is )?(?:turning|becoming) (?:white|blue|black|purple))\b/i,
  /\b(?:heavy|severe|uncontrolled) bleeding\b|\bbleeding (?:heavily|won'?t stop|will not stop)\b/i,
  /\b(?:pus|pus-filled|purulent discharge)\b[\s\S]{0,40}\bfever\b|\bfever\b[\s\S]{0,40}\b(?:pus|pus-filled|purulent discharge)\b/i,
  /\b(?:swelling|swollen)\b[\s\S]{0,40}\b(?:spreading|worsening|getting worse)\b/i,
  /\b(?:face|facial|throat|tongue) (?:is )?(?:swelling|swollen)\b/i,

  // Bahasa Malaysia / common Malaysian chat phrasing
  /\b(kecemasan|darurat|terlalu sakit|sakit teruk|makin sakit|semakin sakit|sakit tak tahan|bengkak teruk)\b/i,
  /\b(sesak nafas|susah bernafas|tak boleh bernafas)\b/i,
  /\b(penglihatan (?:kabur|berubah)|ruam (?:merebak|semakin teruk))\b/i,
  /\b(sakit dada|dada sakit)\b/i,
  /\b(pendarahan (?:banyak|teruk|tak berhenti|tidak berhenti)|darah tak berhenti|darah tidak berhenti)\b/i,
  /\bnanah\b[\s\S]{0,40}\b(demam|panas badan)\b|\b(demam|panas badan)\b[\s\S]{0,40}\bnanah\b/i,
  /\bbengkak\b[\s\S]{0,40}\b(merebak|makin teruk|semakin teruk)\b/i,
  /\b(muka|tekak|lidah) (?:makin |semakin )?bengkak\b/i,

  // Chinese, simplified + common traditional forms
  /(呼吸困难|呼吸困難|不能呼吸|喘不过气|喘不過氣|剧痛|劇痛|痛得受不了|痛到受不了|越来越痛|越來越痛)/u,
  /(越来越严重|越來越嚴重|视力变化|視力變化|看不清|皮疹扩散|皮疹擴散)/u,
  /(胸痛|胸口痛|大量出血|出血不止|流血不止|肿胀扩散|腫脹擴散|越来越肿|越來越腫)/u,
  /(脸肿|臉腫|脸部肿胀|臉部腫脹|喉咙肿|喉嚨腫|舌头肿|舌頭腫)/u,
  /(?:流脓|流膿|有脓|有膿).{0,20}(?:发烧|發燒|发热|發熱)|(?:发烧|發燒|发热|發熱).{0,20}(?:流脓|流膿|有脓|有膿)/u,
];

const SAFETY_HANDOFF_PATTERNS = [
  // English active reactions that warrant staff review, but are not always
  // emergency-level by themselves.
  /\b(?:i'?m|i am) allergic\b|\bi have (?:an )?allerg(?:y|ies)\b|\ballergic reaction\b/i,
  /\b(?:i'?m|i am) (?:having|experiencing) (?:a |some )?side effects?\b/i,
  /\bside effects? (?:after|since)\b|\badverse reaction\b|\bbad reaction\b/i,
  /\b(?:i'?m|i am) in pain\b|\bhurts a lot\b/i,

  // Bahasa Malaysia
  /\b(reaksi alergi|alahan teruk)\b/i,
  /\bsakit sangat\b(?!\s*(?:ke|tak|kah|\?))/i,

  // Chinese
  /(过敏反应|過敏反應|严重过敏|嚴重過敏)/u,
  /(很痛|非常痛)(?!吗|嗎|么|呢|\?|？)/u,
];

const HUMAN_HANDOFF_PATTERNS = [
  // English: explicit human request / complaint.
  /\bspeak (to|with) (a |an )?(human|person|staff|someone|agent)\b/i,
  /\btalk (to|with) (a |an )?(human|person|staff|someone|agent)\b/i,
  /\breal (person|human)\b/i,
  /\b(human|staff) (please|pls)\b/i,
  /\bcomplain(t|ing)?\b/i,
  /\brefund\b/i,
  /\burgent(ly)?\b/i,
  /\blodge (a )?complaint\b/i,
  /\bmanager\b/i,
  /\blawyer\b|\blegal action\b/i,

  // Bahasa Malaysia
  /\b(nak|mahu) (cakap|bercakap) (dengan )?(staff|orang|manusia|agent|ejen)\b/i,
  /\b(cakap|sambung) (dengan )?(staff|orang sebenar|agent|ejen)\b/i,
  /\brefund( duit)?\b|\bpulangkan duit\b/i,
  /\b(aduan|buat aduan|nak complain)\b/i,

  // Chinese
  /(我要|想找|帮我找|转)(真人|人工|客服|工作人员|职员|職員)/u,
  /(真人客服|人工客服|转人工|轉人工|找经理|找經理)/u,
  /(投诉|投訴|我要投诉|我要投訴|退款|退钱|退錢)/u,
];

const TRIGGER_PATTERNS = [
  ...URGENT_SAFETY_PATTERNS,
  ...SAFETY_HANDOFF_PATTERNS,
  ...HUMAN_HANDOFF_PATTERNS,
];

const NEEDS_HUMAN_MARKER = "[[NEEDS_HUMAN]]";
const BOOKING_READY_MARKER = "[[BOOKING_READY]]";
const AI_OUTCOME_MARKERS = [NEEDS_HUMAN_MARKER, BOOKING_READY_MARKER];

function matchesAny(text, patterns) {
  const value = String(text || "");
  return patterns.some((pattern) => pattern.test(value));
}

function isUrgentSafetyMessage(text) {
  return matchesAny(text, URGENT_SAFETY_PATTERNS);
}

function checkKeywordTriggers(text) {
  if (!text) return null;
  if (isUrgentSafetyMessage(text)) return URGENT_SAFETY_REASON;
  if (matchesAny(text, SAFETY_HANDOFF_PATTERNS) || matchesAny(text, HUMAN_HANDOFF_PATTERNS)) {
    return HANDOFF_REASON;
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
  AI_OUTCOME_MARKERS,
  BOOKING_READY_MARKER,
  HANDOFF_REASON,
  HUMAN_HANDOFF_PATTERNS,
  NEEDS_HUMAN_MARKER,
  SAFETY_HANDOFF_PATTERNS,
  TRIGGER_PATTERNS,
  URGENT_SAFETY_PATTERNS,
  URGENT_SAFETY_REASON,
  checkKeywordTriggers,
  extractAiOutcomeSignals,
  extractHandoffSignal,
  isUrgentSafetyMessage,
  stripInternalOutcomeMarkers,
};
