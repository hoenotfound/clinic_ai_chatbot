const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const setupStatusRepo = require("../src/db/setupStatusRepo");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test(
  "setup status history persists checks and webhook activity safely",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `setup_status_it_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await client.connect();

    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    });

    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
    await client.query(
      fs.readFileSync(path.join(__dirname, "..", "src/db/setupStatusSchema.sql"), "utf8")
    );
    await client.query(`
      CREATE TABLE contacts (
        id SERIAL PRIMARY KEY,
        channel TEXT NOT NULL
      );
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id),
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      INSERT INTO contacts (channel) VALUES ('whatsapp'), ('facebook');
      INSERT INTO messages (contact_id, role, created_at) VALUES
        (1, 'user', '2026-09-02T06:00:00.000Z'),
        (1, 'assistant', '2026-09-02T07:00:00.000Z'),
        (2, 'user', '2026-09-02T08:00:00.000Z');
    `);

    const firstCheck = "2026-09-01T01:00:00.000Z";
    const failedCheck = "2026-09-02T01:00:00.000Z";
    await setupStatusRepo.saveCheckResults([
      { key: "whatsapp", status: "ready", summary: "Connected.", checkedAt: firstCheck },
    ], client);
    await setupStatusRepo.saveCheckResults([
      { key: "whatsapp", status: "error", summary: "Connection failed.", checkedAt: failedCheck },
    ], client);

    await setupStatusRepo.recordWebhook("whatsapp_webhook", new Date("2026-09-02T03:00:00.000Z"), client);
    await setupStatusRepo.recordWebhook("whatsapp_webhook", new Date("2026-09-01T03:00:00.000Z"), client);

    await setupStatusRepo.recordAiCandidateOutcome({
      candidateKey: "gemini_test_fingerprint",
      provider: "gemini",
      status: "ready",
      at: new Date("2026-09-02T04:00:00.000Z"),
    }, client);
    await setupStatusRepo.recordAiCandidateOutcome({
      candidateKey: "gemini_test_fingerprint",
      provider: "gemini",
      status: "rate_limited",
      failureKind: "rate_limit",
      at: new Date("2026-09-02T05:00:00.000Z"),
    }, client);

    const rows = await setupStatusRepo.listConnectionHealth(client);
    const byKey = new Map(rows.map((row) => [row.check_key, row]));

    assert.equal(byKey.get("whatsapp").last_check_status, "error");
    assert.equal(byKey.get("whatsapp").last_check_summary, "Connection failed.");
    assert.equal(byKey.get("whatsapp").last_checked_at.toISOString(), failedCheck);
    assert.equal(byKey.get("whatsapp").last_success_at.toISOString(), firstCheck);
    assert.equal(
      byKey.get("whatsapp_webhook").last_webhook_at.toISOString(),
      "2026-09-02T03:00:00.000Z"
    );

    const inboundRows = await setupStatusRepo.listLatestInboundActivity(client);
    const inboundByChannel = new Map(inboundRows.map((row) => [row.channel, row]));
    assert.equal(
      inboundByChannel.get("whatsapp").last_inbound_at.toISOString(),
      "2026-09-02T06:00:00.000Z"
    );
    assert.equal(
      inboundByChannel.get("facebook").last_inbound_at.toISOString(),
      "2026-09-02T08:00:00.000Z"
    );

    const candidateRows = await setupStatusRepo.listAiCandidateHealth(client);
    assert.equal(candidateRows.length, 1);
    assert.equal(candidateRows[0].candidate_key, "gemini_test_fingerprint");
    assert.equal(candidateRows[0].last_status, "rate_limited");
    assert.equal(candidateRows[0].last_failure_kind, "rate_limit");
    assert.equal(candidateRows[0].last_success_at.toISOString(), "2026-09-02T04:00:00.000Z");
    assert.equal(candidateRows[0].last_rate_limited_at.toISOString(), "2026-09-02T05:00:00.000Z");
  }
);
