const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const schemaFiles = [
  "src/db/schema.sql",
  "src/db/leadAttributionSchema.sql",
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

test(
  "lead attribution schema preserves one first-touch row per lead journey",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `lead_attribution_it_${process.pid}_${Date.now()}`;
    const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await client.connect();
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    });

    for (const relativePath of schemaFiles) {
      const sql = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
      await client.query(sql);
    }

    const contact = await client.query(
      `INSERT INTO contacts (whatsapp_number, name)
       VALUES ('60123456789', 'Attribution Test')
       RETURNING id`
    );
    const contactId = Number(contact.rows[0].id);

    const message = await client.query(
      `INSERT INTO messages (contact_id, role, content, whatsapp_message_id)
       VALUES ($1, 'user', 'Hi from ad', 'wamid.attribution-test')
       RETURNING id`,
      [contactId]
    );
    const messageId = Number(message.rows[0].id);

    const stage = await client.query(
      `SELECT id FROM pipeline_stages WHERE system_key = 'new' LIMIT 1`
    );
    const lead = await client.query(
      `INSERT INTO leads (contact_id, stage_id, started_message_id, created_by)
       VALUES ($1, $2, $3, 'Automation')
       RETURNING id`,
      [contactId, stage.rows[0].id, messageId]
    );
    const leadId = Number(lead.rows[0].id);

    await t.test("stores exact Meta ad/click identifiers on the journey", async () => {
      const inserted = await client.query(
        `INSERT INTO lead_attributions (
           lead_id, first_message_id, source, platform, channel,
           meta_ad_id, meta_source_id, meta_source_type, ctwa_clid,
           headline, enrichment_status, raw_referral
         ) VALUES (
           $1, $2, 'meta_ads', 'meta', 'whatsapp',
           '120210000001234', '120210000001234', 'ad', 'clid-test',
           'HIFU Promo', 'pending', '{"source_type":"ad"}'::jsonb
         )
         RETURNING *`,
        [leadId, messageId]
      );

      assert.equal(inserted.rows[0].source, "meta_ads");
      assert.equal(inserted.rows[0].meta_ad_id, "120210000001234");
      assert.equal(inserted.rows[0].ctwa_clid, "clid-test");
      assert.equal(inserted.rows[0].enrichment_status, "pending");
      assert.equal(Number(inserted.rows[0].first_message_id), messageId);
      assert.equal(inserted.rows[0].raw_referral.source_type, "ad");
    });

    await t.test("stores the enriched Meta Ad -> Ad Set -> Campaign hierarchy", async () => {
      const updated = await client.query(
        `UPDATE lead_attributions
         SET meta_account_id = '123456789',
             ad_name = 'HIFU Doctor Video V3',
             adset_id = '120210000001111',
             adset_name = 'Women 25-45 KL',
             campaign_id = '120210000001000',
             campaign_name = 'HIFU September Sales',
             enrichment_status = 'enriched',
             enrichment_attempts = enrichment_attempts + 1,
             enrichment_last_attempt_at = now(),
             enrichment_next_attempt_at = NULL,
             enrichment_last_error = NULL,
             enriched_at = now(),
             updated_at = now()
         WHERE lead_id = $1
         RETURNING *`,
        [leadId]
      );

      const row = updated.rows[0];
      assert.equal(row.enrichment_status, "enriched");
      assert.equal(row.meta_account_id, "123456789");
      assert.equal(row.ad_name, "HIFU Doctor Video V3");
      assert.equal(row.adset_id, "120210000001111");
      assert.equal(row.adset_name, "Women 25-45 KL");
      assert.equal(row.campaign_id, "120210000001000");
      assert.equal(row.campaign_name, "HIFU September Sales");
      assert.ok(row.enriched_at instanceof Date);
    });

    await t.test("rejects a second first-touch attribution for the same lead", async () => {
      await assert.rejects(
        client.query(
          `INSERT INTO lead_attributions (lead_id, source, platform, channel, meta_ad_id)
           VALUES ($1, 'meta_ads', 'meta', 'whatsapp', 'different-ad')`,
          [leadId]
        ),
        (err) => err?.code === "23505"
      );

      const current = await client.query(
        `SELECT meta_ad_id FROM lead_attributions WHERE lead_id = $1`,
        [leadId]
      );
      assert.equal(current.rows[0].meta_ad_id, "120210000001234");
    });

    await t.test("deleting a lead also deletes its attribution row", async () => {
      await client.query(`DELETE FROM leads WHERE id = $1`, [leadId]);
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS count FROM lead_attributions WHERE lead_id = $1`,
        [leadId]
      );
      assert.equal(remaining.rows[0].count, 0);
    });
  }
);
