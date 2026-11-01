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

function followUpChangeRequiresWake(payload) {
  // Reacting to a message or updating only a profile photo/name does not
  // affect whether a scheduled follow-up is allowed or due. Other events,
  // including delivery-status and attention/mode updates, always re-check.
  if (payload?.reason === "reaction") return false;
  if (payload?.reason === "contact_state" &&
      payload?.followUpStateUnchanged === true) return false;
  return true;
}

module.exports = { createCoalescedImmediateWake, followUpChangeRequiresWake };
