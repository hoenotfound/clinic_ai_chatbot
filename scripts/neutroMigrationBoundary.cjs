#!/usr/bin/env node
"use strict";

// Observation only. A quiet database is NOT proof that a process has stopped.
// This command cannot authorize cutover or release any billing reservation.
const { SOURCE_HOST, connectionIdentity } = require("./neutroMigrationHold.cjs");
const ACTIVE = new Set(["processing", "running", "sending", "reserved", "claimed", "dispatching", "in_progress"]);
const UNCERTAIN = new Set(["unknown", "ambiguous", "awaiting_pricing"]);
const q = value => '"' + value.replace(/"/g, '""') + '"';

function classifyCounts(groups) {
  return groups.filter(g => ACTIVE.has(g.value) || UNCERTAIN.has(g.value) || g.value === null);
}

async function inspect(client) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const columns = (await client.query(`SELECT table_name,column_name
      FROM information_schema.columns WHERE table_schema='public'
      AND column_name IN ('state','status','outcome')
      AND (table_name LIKE '%job%' OR table_name LIKE '%attempt%' OR table_name LIKE '%claim%'
        OR table_name LIKE '%gate%' OR table_name IN ('scheduled_messages','whatsapp_result_media_queue'))
      ORDER BY table_name,column_name`)).rows;
    const groups = [];
    for (const { table_name: table, column_name: column } of columns) {
      const rows = (await client.query(`SELECT ${q(column)}::text value,count(*)::int count
        FROM public.${q(table)} GROUP BY ${q(column)} ORDER BY ${q(column)}`)).rows;
      groups.push(...rows.map(row => ({ table, column, ...row })));
    }
    const connections = (await client.query(`SELECT application_name,state,count(*)::int count
      FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND backend_type='client backend' GROUP BY application_name,state ORDER BY 1,2`)).rows;
    const flags = classifyCounts(groups);
    return {
      observedAt: new Date().toISOString(), mode: "read_only_observation",
      cutoverAuthorized: false, processRetirementVerified: false,
      connections, groups, requiresReview: flags,
      explanation: "Verify old Render instance retirement separately. Reconcile in-flight or uncertain sends; never reset reservations. Preserve historical holds unchanged."
    };
  } finally { await client.query("ROLLBACK"); }
}

async function main() {
  const identity = connectionIdentity(process.env.DATABASE_URL);
  if (identity.host !== SOURCE_HOST || identity.database !== "/neondb") throw Error("Source database identity mismatch.");
  const uri = new URL(process.env.DATABASE_URL);
  uri.hostname = identity.host;
  uri.searchParams.set("sslmode", "verify-full");
  const { Client } = require("pg");
  const client = new Client({ connectionString: uri.toString(), application_name: "neutro_migration_boundary_readonly", connectionTimeoutMillis: 10000, query_timeout: 15000 });
  await client.connect();
  try { console.log(JSON.stringify(await inspect(client), null, 2)); }
  finally { await client.end(); }
}
if (require.main === module) main().catch(() => {
  console.error("Read-only migration boundary inspection failed; no cutover authorization.");
  process.exitCode = 1;
});
module.exports = { classifyCounts, inspect };
