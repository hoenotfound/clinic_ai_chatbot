"use strict";

// Passive instrumentation only: pool events are emitted by node-postgres when
// application work is already acquiring a connection. No queries, timers,
// database migrations or customer data are involved.
const { pool } = require("../db/db");

function createPoolActivityTracker(database, { now = Date.now } = {}) {
  let acquiredTotal = 0;
  let connectedTotal = 0;
  let removedTotal = 0;
  let lastAcquireAt = null;
  const perMinute = new Map();

  function prune(minute) {
    for (const key of perMinute.keys()) {
      if (key <= minute - 60) perMinute.delete(key);
    }
  }

  database.on("acquire", () => {
    const time = now();
    const minute = Math.floor(time / 60_000);
    acquiredTotal += 1;
    lastAcquireAt = time;
    perMinute.set(minute, (perMinute.get(minute) || 0) + 1);
    prune(minute);
  });
  database.on("connect", () => { connectedTotal += 1; });
  database.on("remove", () => { removedTotal += 1; });

  function snapshot() {
    const timestamp = now();
    const minute = Math.floor(timestamp / 60_000);
    prune(minute);
    let last5Minutes = 0;
    let last15Minutes = 0;
    for (const [key, count] of perMinute) {
      if (key > minute - 15 && key <= minute) last15Minutes += count;
      if (key > minute - 5 && key <= minute) last5Minutes += count;
    }
    return {
      observedSinceProcessStart: true,
      acquiredTotal,
      connectedTotal,
      removedTotal,
      last5Minutes,
      last15Minutes,
      lastAcquireAt: lastAcquireAt === null ? null : new Date(lastAcquireAt).toISOString(),
      openConnections: database.totalCount,
      idleConnections: database.idleCount,
      waitingForConnection: database.waitingCount,
    };
  }

  return { snapshot };
}

const activity = createPoolActivityTracker(pool);
function getPoolActivitySnapshot() {
  return activity.snapshot();
}

module.exports = { createPoolActivityTracker, getPoolActivitySnapshot };
