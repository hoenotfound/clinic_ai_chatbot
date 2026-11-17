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


// Drop only indentation and full-line SQL comments outside quoted values.
// This saves bytes on every connection, including after idle eviction. Keep
// newlines to preserve token separation, and leave all string/dollar-quoted
// text and block-comment contents intact.
function compactReadSql(sql) {
  if (typeof sql !== "string") return sql;
  const lines = sql.match(/[^\n]*\n|[^\n]+$/g) || [];
  let mode = "normal", dollarTag = "", escapeSingle = false;
  const scan = line => {
    for (let i = 0; i < line.length; i++) {
      const char = line[i], next = line[i + 1];
      if (mode === "single") {
        if (char === "\\" && escapeSingle) { i++; continue; }
        if (char === "'" && next === "'") { i++; continue; }
        if (char === "'") { mode = "normal"; escapeSingle = false; }
        continue;
      }
      if (mode === "double") {
        if (char === '"' && next === '"') { i++; continue; }
        if (char === '"') mode = "normal";
        continue;
      }
      if (mode === "block") {
        if (char === "*" && next === "/") { mode = "normal"; i++; }
        continue;
      }
      if (mode === "dollar") {
        if (line.startsWith(dollarTag, i)) {
          mode = "normal"; i += dollarTag.length - 1;
        }
        continue;
      }
      if (char === "-" && next === "-") break;
      if (char === "/" && next === "*") { mode = "block"; i++; continue; }
      if (char === "'") {
        mode = "single";
        escapeSingle = /(^|[^a-z0-9_])e$/i.test(line.slice(0, i));
        continue;
      }
      if (char === '"') { mode = "double"; continue; }
      if (char === "$") {
        const match = /^\$([a-z_][a-z0-9_]*)?\$/i.exec(line.slice(i));
        if (match) {
          dollarTag = match[0];
          mode = "dollar"; i += dollarTag.length - 1;
        }
      }
    }
  };
  let output = "";
  for (const line of lines) {
    if (mode === "normal" && /^[ \t]*--/.test(line)) {
      if (line.endsWith("\n")) output += "\n";
      continue;
    }
    const next = mode === "normal" ? line.replace(/^[ \t]+/, "") : line;
    output += next;
    scan(next);
  }
  return mode === "normal" ? output : sql;
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
  const text = compactReadSql(sql);
  return database.query({ text, values, name: preparedNameForSql(text) });
}

module.exports = { runFollowUpRead, preparedNameForSql, compactReadSql };
