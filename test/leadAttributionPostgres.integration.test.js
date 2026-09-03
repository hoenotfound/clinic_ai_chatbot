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

function readSchema(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

async function createIsolatedClient(prefix) {
  const schemaName = `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
  return { client, schemaName };
}

async function cleanupIsolatedClient(client, schemaName) {
  await client.query("SET search_path TO public").catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
  await client.end().catch(() => {});
}

test(
  "lead attribution schema preserves one first-touch row per lead journey",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const { client, schemaName } = await createIsolatedClient("lead_attribution_it");

    t.after(async () => {
      await cleanupIsolatedClient(client, schemaName);
    });

    for (const relativePath of schemaFiles) {
      await client.query(readSchema(relativePath));
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

test(
  "lead attribution enrichment schema upgrades an existing PR #65 database safely",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const { client, schemaName } = await createIsolatedClient("lead_attribution_upgrade_it");

    t.after(async () => {
      await cleanupIsolatedClient(client, schemaName);
    });

    await client.query(readSchema("src/db/schema.sql"));

    // Reproduce PR #65's already-deployed attribution table: hierarchy columns
    // existed, but enrichment state/account/retry columns did not yet exist.
    await client.query(`
      CREATE TABLE lead_attributions (
        id SERIAL PRIMARY KEY,
        lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
        first_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        source TEXT NOT NULL,
        platform TEXT,
        channel TEXT NOT NULL,
        meta_ad_id TEXT,
        meta_source_id TEXT,
        meta_source_type TEXT,
        referral_ref TEXT,
        referral_source TEXT,
        referral_type TEXT,
        ctwa_clid TEXT,
        source_url TEXT,
        headline TEXT,
        body TEXT,
        media_type TEXT,
        media_url TEXT,
        campaign_id TEXT,
        campaign_name TEXT,
        adset_id TEXT,
        adset_name TEXT,
        ad_name TEXT,
        raw_referral JSONB,
        attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const stage = await client.query(
      `SELECT id FROM pipeline_stages WHERE system_key = 'new' LIMIT 1`
    );
    const stageId = Number(stage.rows[0].id);

    async function createLegacyLead(number, source, adId, hierarchy = {}) {
      const contact = await client.query(
        `INSERT INTO contacts (whatsapp_number, name)
         VALUES ($1, $2)
         RETURNING id`,
        [number, `Legacy ${number}`]
      );
      const contactId = Number(contact.rows[0].id);
      const message = await client.query(
        `INSERT INTO messages (contact_id, role, content, whatsapp_message_id)
         VALUES ($1, 'user', 'legacy inbound', $2)
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
      const leadId = Number(lead.rows[0].id);
      const attribution = await client.query(
        `INSERT INTO lead_attributions (
           lead_id, first_message_id, source, platform, channel, meta_ad_id,
           campaign_id, campaign_name, adset_id, adset_name, ad_name, updated_at
         ) VALUES ($1, $2, $3, $4, 'whatsapp', $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          leadId,
          messageId,
          source,
          source === "meta_ads" ? "meta" : null,
          adId,
          hierarchy.campaignId || null,
          hierarchy.campaignName || null,
          hierarchy.adsetId || null,
          hierarchy.adsetName || null,
          hierarchy.adName || null,
          new Date("2026-01-01T00:00:00.000Z"),
        ]
      );
      return Number(attribution.rows[0].id);
    }

    const pendingId = await createLegacyLead("60111111111", "meta_ads", "120210000001001");
    const completeId = await createLegacyLead(
      "60222222222",
      "meta_ads",
      "120210000001002",
      {
        campaignId: "120210000001100",
        campaignName: "Existing Campaign",
        adsetId: "120210000001110",
        adsetName: "Existing Ad Set",
        adName: "Existing Ad",
      }
    );
    const organicId = await createLegacyLead("60333333333", "whatsapp_unattributed", null);

    const upgradeSql = readSchema("src/db/leadAttributionSchema.sql");
    await client.query(upgradeSql);
    // Startup schemas are intentionally run on every deploy. Prove the second
    // execution is also safe and does not rewrite non-ad rows.
    await client.query(upgradeSql);

    const columns = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'lead_attributions'`,
      [schemaName]
    );
    const columnNames = new Set(columns.rows.map((row) => row.column_name));
    for (const expected of [
      "meta_account_id",
      "enrichment_status",
      "enrichment_attempts",
      "enrichment_last_attempt_at",
      "enrichment_next_attempt_at",
      "enrichment_last_error",
      "enriched_at",
    ]) {
      assert.equal(columnNames.has(expected), true, `missing upgraded column ${expected}`);
    }

    const rows = await client.query(
      `SELECT id, source, enrichment_status, enriched_at, updated_at
       FROM lead_attributions
       WHERE id = ANY($1::int[])
       ORDER BY id`,
      [[pendingId, completeId, organicId]]
    );
    const byId = new Map(rows.rows.map((row) => [Number(row.id), row]));

    assert.equal(byId.get(pendingId).enrichment_status, "pending");
    assert.equal(byId.get(pendingId).enriched_at, null);

    assert.equal(byId.get(completeId).enrichment_status, "enriched");
    assert.ok(byId.get(completeId).enriched_at instanceof Date);

    assert.equal(byId.get(organicId).enrichment_status, "not_applicable");
    assert.equal(byId.get(organicId).enriched_at, null);
    assert.equal(
      byId.get(organicId).updated_at.toISOString(),
      "2026-01-01T00:00:00.000Z",
      "idempotent enrichment migration must not rewrite organic/direct attribution rows"
    );
  }
);
