import { classifyWhatsAppEmbeddedSignupEvent } from "./whatsappEmbeddedSignup.js";

// The Facebook SDK owns the popup. Keep the attempt scoped to this component and
// require both Meta signals before reporting success or validating coexistence.
export function createWhatsAppEmbeddedSignupAttempt(id, nonce) {
  return { id, nonce, phase: "waiting", code: null, completion: null };
}

function resolveAttempt(attempt) {
  if (!attempt.code || !attempt.completion) return { kind: "waiting" };

  attempt.phase = "closed";
  if (attempt.completion.kind === "standard") {
    return { kind: "standard" };
  }
  return {
    kind: "coexistence",
    code: attempt.code,
    nonce: attempt.nonce,
    sessionInfo: attempt.completion.payload,
  };
}

export function receiveWhatsAppSignupAuthorization(attempt, response) {
  if (!attempt || attempt.phase !== "waiting") return { kind: "ignored" };
  const code = response?.authResponse?.code;
  if (typeof code !== "string" || !code.trim()) {
    attempt.phase = "closed";
    return { kind: "missing_code", cancelled: response?.status === "unknown" };
  }
  attempt.code = code.trim();
  return resolveAttempt(attempt);
}

export function receiveWhatsAppSignupMessage(attempt, payload) {
  if (!attempt || attempt.phase !== "waiting") return { kind: "ignored" };
  const kind = classifyWhatsAppEmbeddedSignupEvent(payload);
  if (!kind) return { kind: "ignored" };

  if (kind === "error" || kind === "cancel") {
    attempt.phase = "closed";
    return {
      kind,
      message: kind === "error" ? payload.data?.error_message : null,
    };
  }

  // Conflicting completion events can come from different Meta popup flows.
  // Do not choose one or activate anything when the completion type changes.
  if (attempt.completion && attempt.completion.kind !== kind) {
    attempt.phase = "closed";
    return { kind: "conflict" };
  }

  attempt.completion = { kind, payload };
  return resolveAttempt(attempt);
}

export function expireWhatsAppSignupAttempt(attempt) {
  if (!attempt || attempt.phase !== "waiting") return { kind: "ignored" };
  attempt.phase = "closed";
  return attempt.code
    ? { kind: "unconfirmed" }
    : { kind: "missing_code", cancelled: false };
}
