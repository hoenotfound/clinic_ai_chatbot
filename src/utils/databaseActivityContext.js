"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

// Static operational labels only. Never use contact IDs, phones, SQL, URLs or
// user-provided values as sources. This module creates no timers or queries.
const activitySource = new AsyncLocalStorage();
const UNATTRIBUTED_SOURCE = "unattributed";

function normalizedDatabaseActivitySource(source) {
  const name = typeof source === "string" ? source : "";
  return name.length > 0 && name.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)
    ? name : UNATTRIBUTED_SOURCE;
}

function withDatabaseActivitySource(source, run) {
  if (typeof run !== "function") throw new TypeError("Database activity scope needs a function");
  return activitySource.run(normalizedDatabaseActivitySource(source), run);
}

function currentDatabaseActivitySource() {
  return activitySource.getStore() || UNATTRIBUTED_SOURCE;
}

module.exports = {
  UNATTRIBUTED_SOURCE,
  currentDatabaseActivitySource,
  normalizedDatabaseActivitySource,
  withDatabaseActivitySource,
};
