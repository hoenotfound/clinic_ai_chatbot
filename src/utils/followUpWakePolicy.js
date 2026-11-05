"use strict";

// Group only synchronous bursts of internal events within the same event-loop
// turn. Unlike timers/debouncing, a microtask adds no wall-clock delay and
// preserves worker due-time and failure-retry scheduling.
function createCoalescedImmediateWake(wake, scheduleMicrotask = queueMicrotask) {
  if (typeof wake !== "function" || typeof scheduleMicrotask !== "function") {
    throw new TypeError("A worker wake and microtask scheduler are required.");
  }
  let queued = false;
  return function signal() {
    if (queued) return false;
    queued = true;
    scheduleMicrotask(() => {
      queued = false;
      wake();
    });
    return true;
  };
}

function followUpChangeRequiresWake(payload, env = process.env) {
  // Reacting or changing presentation-only state cannot affect a follow-up.
  if (payload?.reason === "reaction") return false;
  if (payload?.reason === "contact_state" &&
      payload?.followUpStateUnchanged === true) return false;
  // Signed secondary delivery receipts change only the *secondary* message's
  // status. They must not launch a new primary follow-up scan. Require both
  // configured numbers and a verified sender; unknown events, real messages,
  // booking and opt-out changes still wake immediately.
  if (payload?.reason === "delivery_status" &&
      payload?.channel === "whatsapp" &&
      env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID &&
      String(env.WHATSAPP_PHONE_NUMBER_ID) !== String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) &&
      String(payload.businessPhoneNumberId || "") ===
        String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) return false;
  return true;
}

module.exports = { createCoalescedImmediateWake, followUpChangeRequiresWake };
