const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

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

async function connectToSchema(schemaName) {
  const client = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await client.connect();
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
  return client;
}

async function resetFixtures(client) {
  await client.query(
    "TRUNCATE lead_distribution_cursors, users, contacts RESTART IDENTITY CASCADE"
  );
}

async function seedSales(client, { username, permissions = {}, active = true, branch = null }) {
  await client.query(
    `INSERT INTO users (
       username, password_hash, display_name, role, permissions, is_active, branch_name
     ) VALUES ($1, 'test-hash', $1, 'sales', $2::jsonb, $3, $4)`,
    [username, JSON.stringify(permissions), active, branch]
  );
}

let contactSequence = 0;
async function createContact(client) {
  contactSequence += 1;
  const result = await client.query(
    `INSERT INTO contacts (whatsapp_number, name)
     VALUES ($1, $2)
     RETURNING id`,
    [`safety-${process.pid}-${Date.now()}-${contactSequence}`, `Safety ${contactSequence}`]
  );
  return Number(result.rows[0].id);
}

async function insertLead(client, { contactId, ownerUsername = null, branchName = null } = {}) {
  const id = contactId || await createContact(client);
  return client.query(
    `INSERT INTO leads (contact_id, owner_username, branch_name, created_by)
     VALUES ($1, $2, $3, 'Automation')
     RETURNING id, owner_username, owner_assignment_source, branch_name`,
    [id, ownerUsername, branchName]
  );
}

test(
  "lead distribution safety rules execute correctly in PostgreSQL",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `lead_distribution_safety_${process.pid}_${Date.now()}`;
    const setup = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await setup.connect();
    await setup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
    await setup.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await setup.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

    t.after(async () => {
      await setup.query("SET search_path TO public").catch(() => {});
      await setup.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
      await setup.end().catch(() => {});
    });

    for (const relativePath of schemaFiles) {
      const sql = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
      await setup.query(sql);
    }

    await setup.query(
      `INSERT INTO clinic_config (id, data)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify({
        leadDistribution: { enabled: true, strategy: "round_robin" },
        branches: [
          { name: "Puchong", address: "", phone: "" },
          { name: "Kuala Lumpur", address: "", phone: "" },
        ],
      })]
    );

    await t.test("manual ownership rejects staff who cannot service assigned leads", async () => {
      await resetFixtures(setup);
      await seedSales(setup, { username: "eligible" });
      await seedSales(setup, {
        username: "cannot_reply",
        permissions: { reply_to_assigned_leads: false },
      });

      await assert.rejects(
        () => insertLead(setup, { ownerUsername: "cannot_reply" }),
        (err) => err?.code === "P0001" && /cannot currently view and reply/i.test(err.message)
      );

      const result = await insertLead(setup, { ownerUsername: "eligible" });
      assert.equal(result.rows[0].owner_username, "eligible");
      assert.equal(result.rows[0].owner_assignment_source, "manual");
    });

    await t.test("new or changed stale branch names are rejected while current names canonicalize", async () => {
      await resetFixtures(setup);
      await seedSales(setup, { username: "sales_a", branch: "Puchong" });

      await assert.rejects(
        () => insertLead(setup, { branchName: "Old PJ" }),
        (err) => err?.code === "P0001" && /no longer configured/i.test(err.message)
      );

      const current = await insertLead(setup, { branchName: "puchong" });
      assert.equal(current.rows[0].branch_name, "Puchong");

      await assert.rejects(
        () => setup.query(
          "UPDATE leads SET branch_name = 'Removed Branch' WHERE id = $1",
          [current.rows[0].id]
        ),
        (err) => err?.code === "P0001" && /no longer configured/i.test(err.message)
      );
    });

    await t.test("initial automatic assignment is recorded in Lead Activities", async () => {
      await resetFixtures(setup);
      await seedSales(setup, { username: "sales_a" });

      const inserted = await insertLead(setup);
      assert.equal(inserted.rows[0].owner_username, "sales_a");
      assert.equal(inserted.rows[0].owner_assignment_source, "automatic");

      const activities = await setup.query(
        `SELECT description, actor, metadata
         FROM lead_activities
         WHERE lead_id = $1
           AND metadata ->> 'source' = 'lead_distribution_initial'`,
        [inserted.rows[0].id]
      );
      assert.equal(activities.rowCount, 1);
      assert.match(activities.rows[0].description, /Automatically assigned to sales_a/i);
      assert.equal(activities.rows[0].actor, "Lead distribution");
      assert.equal(activities.rows[0].metadata.ownerUsername, "sales_a");
    });

    await t.test("assignment row lock blocks a simultaneous staff eligibility mutation", async () => {
      await resetFixtures(setup);
      await seedSales(setup, { username: "sales_a" });
      const contactId = await createContact(setup);

      const assignmentClient = await connectToSchema(schemaName);
      const staffClient = await connectToSchema(schemaName);
      t.after(async () => {
        await assignmentClient.end().catch(() => {});
        await staffClient.end().catch(() => {});
      });

      await assignmentClient.query("BEGIN");
      const inserted = await insertLead(assignmentClient, { contactId });
      assert.equal(inserted.rows[0].owner_username, "sales_a");

      await staffClient.query("BEGIN");
      await staffClient.query("SET LOCAL statement_timeout = 3000");
      let staffLockResolved = false;
      const staffLockPromise = staffClient
        .query("SELECT id FROM users WHERE username = 'sales_a' FOR UPDATE")
        .then((result) => {
          staffLockResolved = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        staffLockResolved,
        false,
        "Team & Access FOR UPDATE should wait while assignment holds FOR SHARE"
      );

      await assignmentClient.query("COMMIT");
      await staffLockPromise;

      const owned = await staffClient.query(
        `SELECT COUNT(*)::int AS count
         FROM leads
         WHERE is_closed = false AND owner_username = 'sales_a'`
      );
      assert.equal(Number(owned.rows[0].count), 1);
      await staffClient.query("ROLLBACK");
    });
  }
);
