"use strict";

// Reduce repeated SQL text sent to Neon without changing the query or result.
// Opt-in only for the actual production pool. Fake/staging injected databases
// retain their existing call contract, and failures are never replayed.
const { createHash } = require("node:crypto");
const MAX_CACHED_STATEMENTS = 12;
const preparedNames = new Map();

function preparedNameForSql(sql) {
  const previous = preparedNames.get(sql);
  if (previous) return previous;
  const name = "ns_followup_" +
    createHash("sha256").update(sql).digest("hex").slice(0, 40);
  if (preparedNames.size < MAX_CACHED_STATEMENTS) preparedNames.set(sql, name);
  return name;
}

function runFollowUpRead(database, productionPool, sql, values, {
  env = process.env,
} = {}) {
  if (env?.NEUTRO_NAMED_FOLLOWUP_READS_ENABLED !== "true" ||
      database !== productionPool) {
    return database.query(sql, values);
  }
  // node-postgres sends Parse/SQL once per connection for each stable name,
  // then uses Bind/Execute on later reads. Names include a digest of exact
  // SQL, so updated releases cannot reuse a stale prepared statement.
  // No retries: the scheduler's existing failure handling is unchanged.
  return database.query({ text: sql, values, name: preparedNameForSql(sql) });
}

module.exports = { runFollowUpRead, preparedNameForSql };
