const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const {
  getLeadReengagementContext,
} = require("../src/services/leadReengagementAlertService");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "lead re-engagement context reads the prior customer turn and latest stored AI summary in Postgres",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `lead_reengagement_${process.pid}_${Date.now()}`;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          whatsapp_number TEXT,
          name TEXT,
          whatsapp_profile_name TEXT,
          channel TEXT,
          channel_user_id TEXT
        );

        CREATE TABLE pipeline_stages (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );

        CREATE TABLE leads (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          stage_id INTEGER REFERENCES pipeline_stages(id),
          temperature TEXT,
          treatment_interest TEXT,
          branch_name TEXT
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL,
          content TEXT,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE lead_temperature_scores (
          id INTEGER PRIMARY KEY,
          lead_id INTEGER NOT NULL REFERENCES leads(id),
          through_message_id INTEGER NOT NULL REFERENCES messages(id),
          status TEXT NOT NULL,
          summary_data JSONB NOT NULL DEFAULT '{}'::jsonb
        );

        INSERT INTO contacts (
          id, whatsapp_number, whatsapp_profile_name, channel
        ) VALUES (12, '60123456789', 'Jason', 'whatsapp');

        INSERT INTO pipeline_stages (id, name)
        VALUES (1, 'No Reply');

        INSERT INTO leads (
          id, contact_id, stage_id, temperature, treatment_interest, branch_name
        ) VALUES (7, 12, 1, 'hot', 'HIFU', 'Puchong');

        INSERT INTO messages (
          id, contact_id, role, content, created_at
        ) VALUES
          (44, 12, 'user', 'How much is HIFU?', '2026-09-24T04:00:00Z'),
          (45, 12, 'assistant', 'The current promo starts from RM...', '2026-09-24T04:01:00Z'),
          (90, 12, 'user', 'Hi, the promo still have?', '2026-09-28T04:00:00Z');

        INSERT INTO lead_temperature_scores (
          id, lead_id, through_message_id, status, summary_data
        ) VALUES (
          5,
          7,
          44,
          'completed',
          '{"chatSummary":"Customer previously asked about HIFU pricing and then stopped replying."}'::jsonb
        );
      `);

      const context = await getLeadReengagementContext(
        { contactId: 12, currentMessageId: 90, leadId: 7 },
        client.query.bind(client)
      );

      assert.equal(context.contact_id, 12);
      assert.equal(context.current_message_id, 90);
      assert.equal(context.previous_customer_message_id, 44);
      assert.equal(Number(context.gap_hours), 96);
      assert.equal(context.lead_id, 7);
      assert.equal(context.temperature, "hot");
      assert.equal(context.stage_name, "No Reply");
      assert.equal(
        context.previous_ai_summary,
        "Customer previously asked about HIFU pricing and then stopped replying."
      );
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
