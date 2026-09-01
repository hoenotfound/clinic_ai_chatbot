const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const {
  buildConversationSummaryMessage,
} = require("../src/services/telegramAlertService");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const schemaFiles = [
  "src/db/schema.sql",
  "src/db/telegramAlertsSchema.sql",
  "src/db/socialChannelsSchema.sql",
  "src/db/accessControlSchema.sql",
  "src/db/leadDistributionSafetySchema.sql",
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function score() {
  return {
    temperature: "warm",
    confidence: "high",
    reason: "Test summary",
    summary: {
      treatmentInterest: "HIFU",
      preferredBranch: null,
      preferredAppointment: null,
      mainConcern: "Test concern",
      chatSummary: "Test conversation summary.",
      nextAction: "Follow up with the customer.",
    },
  };
}

function formatLeadOwner(row) {
  return buildConversationSummaryMessage({
    lead: {
      ...row,
      contact_id: row.contact_id || 1,
      whatsapp_number: "60123456789",
      whatsapp_profile_name: "Test Customer",
      stage_name: "New Lead",
      current_temperature: "warm",
      appointment_status: "none",
    },
    score: score(),
  });
}

test("Telegram claim reads the current lead owner and staff display name", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/db/telegramAlertRepo.js"),
    "utf8"
  );

  assert.match(source, /LEFT JOIN users u ON u\.username = l\.owner_username/);
  assert.match(source, /l\.owner_username/);
  assert.match(source, /u\.display_name AS owner_display_name/);
});

test(
  "Telegram owner line works with automatic assignment on, off, and manual assignment",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `telegram_owner_it_${process.pid}_${Date.now()}`;
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

    await client.query(
      `INSERT INTO clinic_config (id, data)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify({
        leadDistribution: {
          enabled: true,
          strategy: "round_robin",
          assignByBranch: true,
        },
        branches: [],
      })]
    );

    await client.query(
      `INSERT INTO users (
         username, password_hash, display_name, role, permissions, is_active
       ) VALUES ('amy', 'test-hash', 'Amy Tan', 'sales', '{}'::jsonb, true)`
    );

    const createLead = async (suffix) => {
      const contact = await client.query(
        `INSERT INTO contacts (whatsapp_number, name)
         VALUES ($1, $2)
         RETURNING id`,
        [`telegram-owner-${suffix}-${Date.now()}`, `Customer ${suffix}`]
      );
      const inserted = await client.query(
        `INSERT INTO leads (contact_id, created_by)
         VALUES ($1, 'Automation')
         RETURNING id, contact_id, owner_username`,
        [contact.rows[0].id]
      );
      return inserted.rows[0];
    };

    const readLeadOwner = async (leadId) => {
      const result = await client.query(
        `SELECT l.contact_id, l.owner_username,
                u.display_name AS owner_display_name
         FROM leads l
         LEFT JOIN users u ON u.username = l.owner_username
         WHERE l.id = $1`,
        [leadId]
      );
      return result.rows[0];
    };

    // Automatic Lead Distribution ON: the database assigns Amy and Telegram
    // shows the friendly staff display name.
    const autoLead = await createLead("auto-on");
    assert.equal(autoLead.owner_username, "amy");
    const autoText = formatLeadOwner(await readLeadOwner(autoLead.id));
    assert.match(autoText, /Assigned to: Amy Tan/);

    // Automatic Lead Distribution OFF: a new lead remains unassigned, but
    // Telegram still sends the same summary format and says Unassigned.
    await client.query(
      `UPDATE clinic_config
       SET data = jsonb_set(data, '{leadDistribution,enabled}', 'false'::jsonb, true)
       WHERE id = 1`
    );
    const unassignedLead = await createLead("auto-off");
    assert.equal(unassignedLead.owner_username, null);
    const unassignedText = formatLeadOwner(await readLeadOwner(unassignedLead.id));
    assert.match(unassignedText, /Assigned to: Unassigned/);

    // Manual assignment still works while the automatic tool is off, and the
    // Telegram summary reflects the actual current owner rather than the tool state.
    await client.query(
      `UPDATE leads SET owner_username = 'amy' WHERE id = $1`,
      [unassignedLead.id]
    );
    const manualText = formatLeadOwner(await readLeadOwner(unassignedLead.id));
    assert.match(manualText, /Assigned to: Amy Tan/);
  }
);
