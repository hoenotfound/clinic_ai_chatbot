const VALID_FOLLOW_UP_ACTIONS = new Set(["send", "skip", "human_review"]);
const MAX_FOLLOW_UP_MESSAGE_LENGTH = 1000;
const MAX_FOLLOW_UP_REASON_LENGTH = 400;
const MAX_FOLLOW_UP_TOPIC_LENGTH = 200;

function invalidResponse(message) {
  const err = new Error(message);
  err.code = "INVALID_AI_RESPONSE";
  return err;
}

function stripJsonFence(value) {
  const text = String(value || "").trim();
  const match = /^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(text);
  return match ? match[1].trim() : text;
}

function cleanText(value, maxLength) {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw invalidResponse("AI follow-up fields must be strings.");
  }
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function containsInternalScaffolding(value) {
  const text = String(value || "");
  return (
    /structured\s+output\s*[-:：]?/i.test(text)
    || /json\s+construction\s*:/i.test(text)
    || /(?:^|[{,\n])\s*["']?(?:action|reason|topic)["']?\s*:/m.test(text)
  );
}

function parseFollowUpAiResult(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    const err = new Error("AI returned an empty follow-up decision.");
    err.code = "EMPTY_AI_RESPONSE";
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch (cause) {
    const err = invalidResponse("AI returned malformed follow-up JSON.");
    err.cause = cause;
    throw err;
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw invalidResponse("AI follow-up response must be a JSON object.");
  }

  const action = String(parsed.action || "").trim().toLowerCase();
  if (!VALID_FOLLOW_UP_ACTIONS.has(action)) {
    throw invalidResponse("AI follow-up response is missing a valid action.");
  }

  if (
    typeof parsed.message === "string" &&
    parsed.message.trim().length > MAX_FOLLOW_UP_MESSAGE_LENGTH
  ) {
    throw invalidResponse("AI follow-up message is too long.");
  }

  const message = cleanText(parsed.message, MAX_FOLLOW_UP_MESSAGE_LENGTH);
  const reason = cleanText(parsed.reason, MAX_FOLLOW_UP_REASON_LENGTH);
  const topic = cleanText(parsed.topic, MAX_FOLLOW_UP_TOPIC_LENGTH);

  if (action === "send") {
    if (!message) {
      throw invalidResponse("AI follow-up send action requires a customer-facing message.");
    }
    if (containsInternalScaffolding(message)) {
      throw invalidResponse("AI follow-up message contained internal structured-output content.");
    }
  }

  if ((action === "skip" || action === "human_review") && !reason) {
    throw invalidResponse(`AI follow-up ${action} action requires an internal reason.`);
  }

  return {
    action,
    message: action === "send" ? message : "",
    reason,
    topic,
  };
}

module.exports = {
  MAX_FOLLOW_UP_MESSAGE_LENGTH,
  MAX_FOLLOW_UP_REASON_LENGTH,
  MAX_FOLLOW_UP_TOPIC_LENGTH,
  VALID_FOLLOW_UP_ACTIONS,
  parseFollowUpAiResult,
};
