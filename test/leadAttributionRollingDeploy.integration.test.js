const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function readSchema(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test(
  "PR #65-shaped inserts remain enrichable during a rolling #67 deploy",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `lead_attribution_rollout_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await client.connect();
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    });

    await client.query(readSchema("src/db/schema.sql"));
    await client.query(readSchema("src/db/leadAttributionSchema.sql"));

    const stage = await client.query(
      `SELECT id FROM pipeline_stages WHERE system_key = 'new' LIMIT 1`
    );
    const stageId = Number(stage.rows[0].id);

    async function createLead(number) {
      const contact = await client.query(
        `INSERT INTO contacts (whatsapp_number, name)
         VALUES ($1, $2)
         RETURNING id`,
        [number, `Rolling ${number}`]
      );
      const contactId = Number(contact.rows[0].id);
      const message = await client.query(
        `INSERT INTO messages (contact_id, role, content, whatsapp_message_id)
         VALUES ($1, 'user', 'rolling deploy inbound', $2)
         RETURNING id`,
        [contactId, `wamid.${number}`]
      );
      const messageId = Number(message.rows[0].id);
      const lead = await client.query(
        `INSERT INTO leads (contact_id, stage_id, started_message_id, created_by)
         VALUES ($1, $2, $3, 'Automation')
         RETURNING id`,
        [contactId, stageId, messageId]
      );
      return { leadId: Number(lead.rows[0].id), messageId };
    }

    const metaLead = await createLead("60444444444");
    const metaRow = await client.query(
      `INSERT INTO lead_attributions (
         lead_id, first_message_id, source, platform, channel, meta_ad_id
       ) VALUES ($1, $2, 'meta_ads', 'meta', 'whatsapp', '120210000001003')
       RETURNING enrichment_status`,
      [metaLead.leadId, metaLead.messageId]
    );

    // This INSERT intentionally matches the old #65 write shape and omits all
    // #67 enrichment columns. The database trigger must still queue the row so
    // a zero-downtime overlap cannot lose Meta hierarchy enrichment.
    assert.equal(metaRow.rows[0].enrichment_status, "pending");

    const directLead = await createLead("60555555555");
    const directRow = await client.query(
      `INSERT INTO lead_attributions (
         lead_id, first_message_id, source, platform, channel
       ) VALUES ($1, $2, 'whatsapp_unattributed', 'whatsapp', 'whatsapp')
       RETURNING enrichment_status`,
      [directLead.leadId, directLead.messageId]
    );

    assert.equal(directRow.rows[0].enrichment_status, "not_applicable");
  }
);
