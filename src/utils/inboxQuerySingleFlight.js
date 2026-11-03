"use strict";

// Reuse only IN-FLIGHT reads for the same trusted database WAL revision.
// Completed Inbox data is never cached. Each HTTP route still independently
// checks current staff permissions before returning any customer rows.
function createSameRevisionSingleFlight() {
  const inFlight = new Map();
  return function share(revision, load) {
    if (typeof load !== "function") {
      throw new TypeError("Inbox query loader must be a function");
    }
    if (typeof revision !== "string" || !/^[0-9A-F]+\/[0-9A-F]+$/i.test(revision)) {
      return load();
    }
    const current = inFlight.get(revision);
    if (current) return current;
    let pending;
    pending = Promise.resolve().then(load).finally(() => {
      if (inFlight.get(revision) === pending) inFlight.delete(revision);
    });
    inFlight.set(revision, pending);
    return pending;
  };
}

module.exports = { createSameRevisionSingleFlight };
