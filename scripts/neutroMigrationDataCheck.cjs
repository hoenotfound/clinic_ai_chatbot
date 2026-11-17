#!/usr/bin/env node
"use strict";

// Read-only runner connectivity and database preparation checks. Never imports
// application startup, creates a database, copies data or deploys a service.
const { api, inspect, verifyRecoveredSource } = require("./neutroMigrationRecovery.cjs");
const { SOURCE_HOST, DESTINATION_HOST, connectionIdentity } = require("./neutroMigrationHold.cjs");
const EXPECTED_SENDERS = [
  { sender_key: "neutro", meta_phone_number_id: "1408739622311791", meta_account_id: "1593376338308612", state: "active", coexistence_enabled: false },
  { sender_key: "neutro_secondary", meta_phone_number_id: "1318355951360575", meta_account_id: "1852014482431209", state: "active", coexistence_enabled: true },
];

function clientOptions(raw, host, database = "neondb") {
  const identity = connectionIdentity(raw);
  if (identity.host !== host || identity.database !== "/neondb") throw Error("Unexpected database identity.");
  const u = new URL(raw);
  if (!u.username || !u.password || (u.port && u.port !== "5432")) throw Error("Incomplete database credential.");
  // Construct only reviewed parameters. Do not inherit URL options that could
  // weaken TLS or change session behavior.
  return {
    host, port: 5432, database,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    ssl: { rejectUnauthorized: true },
    application_name: "neutro_migration_data_check",
    connectionTimeoutMillis: 15000, query_timeout: 30000,
    options: "-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000",
  };
}

const SUMMARY_SQL = `SELECT current_database() database,
  current_setting('server_version_num')::int server_version,
  (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')) tables,
  (SELECT count(*)::int FROM schema_migrations) migrations,
  (SELECT md5(string_agg(version||':'||name||':'||checksum,',' ORDER BY version)) FROM schema_migrations) migration_digest,
  (SELECT count(*)::int FROM contacts) contacts,
  (SELECT count(*)::int FROM messages) messages,
  (SELECT count(*)::int FROM whatsapp_sender_status_receipts) receipts,
  (SELECT count(*)::int FROM pg_sequences WHERE schemaname='public') sequences,
  (SELECT count(*)::int FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND NOT convalidated) unvalidated_foreign_keys,
  (SELECT count(*)::int FROM messages m LEFT JOIN contacts c ON c.id=m.contact_id WHERE m.contact_id IS NOT NULL AND c.id IS NULL) orphan_messages,
  (SELECT count(*)::int FROM inbound_processing_jobs WHERE status<>'completed' AND terminal_at IS NULL) open_inbound,
  (SELECT count(*)::int FROM whatsapp_delivery_status_jobs WHERE processing_status<>'completed' AND terminal_at IS NULL) open_receipts,
  (SELECT count(*)::int FROM whatsapp_sender_billing_attempts WHERE state='unknown') unknown_attempts,
  (SELECT count(*)::int FROM whatsapp_sender_billing_gates WHERE state='unknown') unknown_gates,
  pg_database_size(current_database())::text database_bytes`;

async function withReadOnly(Client, options, fn) {
  const client = new Client(options);
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } finally { await client.end(); }
}

function validateSummary(summary, senders, database = "neondb") {
  if (!summary || summary.database !== database || summary.server_version < 180000 || summary.server_version >= 190000 ||
      summary.tables !== 115 || summary.migrations !== 133 || summary.sequences !== 53 ||
      summary.unvalidated_foreign_keys !== 0 || summary.orphan_messages !== 0)
    throw Error("Database schema or relationship checks differ from reviewed baseline.");
  if (JSON.stringify(senders) !== JSON.stringify(EXPECTED_SENDERS)) throw Error("WhatsApp sender registration mismatch.");
}

async function dataCheck({ request, destinationUrl, Client, emit, fetchImpl = global.fetch, referenceDatabase = "neondb" }) {
  if (!destinationUrl) throw Error("Protected destination connection is not configured.");
  if (!["neondb","neutro_initial_20261117"].includes(referenceDatabase)) throw Error("Unreviewed reference database.");
  const destination = clientOptions(destinationUrl, DESTINATION_HOST, referenceDatabase);
  const before = await inspect(request);
  await verifyRecoveredSource({ request, expectedDeploy: before.liveDeploy, emit, fetchImpl });
  const env = await request("/env-vars/DATABASE_URL");
  const source = clientOptions((env.envVar || env).value, SOURCE_HOST);
  const summaries = [];
  for (const options of [source, destination]) {
    summaries.push(await withReadOnly(Client, options, async client => {
      const summary = (await client.query(SUMMARY_SQL)).rows[0];
      const senders = (await client.query("SELECT sender_key,meta_phone_number_id,meta_account_id,state,coexistence_enabled FROM whatsapp_sender_accounts ORDER BY sender_key")).rows;
      validateSummary(summary, senders, options.database);
      return summary;
    }));
  }
  if (summaries[0].migration_digest !== summaries[1].migration_digest) throw Error("Migration history differs between databases.");
  const archives = await withReadOnly(Client, { ...destination, database: "neutro_backup_20261116" }, async client =>
    (await client.query("SELECT id,octet_length(archive) bytes,sha256=encode(pg_catalog.sha256(archive),'hex') checksum_matches FROM migration_archive.production_dump ORDER BY created_at")).rows);
  if (!archives.some(a => a.id === "initial-20261116") || !archives.some(a => a.id === "rehearsal-1794834186228") ||
      archives.some(a => !a.checksum_matches || a.bytes <= 0)) throw Error("Required archived backup verification failed.");
  await verifyRecoveredSource({ request, expectedDeploy: before.liveDeploy, emit, fetchImpl });
  emit({ phase: "read_only_data_access_verified", source: summaries[0], destination: summaries[1], archives,
    finalCopyVerified: false, cutoverReady: false,
    explanation: "Independent snapshots while production is running. Counts are observations, not a final full-record comparison." });
}

async function main() {
  if (process.argv[2] !== "--read-only" || process.env.RENDER_SERVICE_ID || process.env.NODE_OPTIONS)
    throw Error("Use the independent read-only runner without Node preloads.");
  await dataCheck({ request: api(process.env.RENDER_API_KEY), destinationUrl: process.env.NEUTRO_MIGRATION_DESTINATION_URL,
    Client: require("pg").Client, emit: data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data })) });
}
if (require.main === module) main().catch(() => {
  console.error("DATA_CHECK_STOPPED: Read-only preparation failed. Provider details and credentials withheld.");
  process.exitCode = 1;
});
module.exports = { clientOptions, dataCheck, validateSummary, EXPECTED_SENDERS, SUMMARY_SQL };
