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
];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function connectToTestSchema(schemaName) {
  const client = new Client({
    connectionString: TEST_DATABASE_URL,
    ssl: false,
  });
  await client.connect();
  await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
  return client;
}

async function resetFixtures(client) {
  await client.query(
    "TRUNCATE lead_distribution_cursors, users, contacts RESTART IDENTITY CASCADE"
  );
}

async function seedSales(client, users) {
  for (const user of users) {
    await client.query(
      `INSERT INTO users (
         username, password_hash, display_name, role, permissions, is_active, branch_name
       ) VALUES ($1, 'test-hash', $2, 'sales', '{}'::jsonb, $3, $4)`,
      [user.username, user.username, user.active !== false, user.branch || null]
    );
  }
}

let contactSequence = 0;
async function createContact(client) {
  contactSequence += 1;
  const result = await client.query(
    `INSERT INTO contacts (whatsapp_number, name)
     VALUES ($1, $2)
     RETURNING id`,
    [`integration-${process.pid}-${Date.now()}-${contactSequence}`, `Contact ${contactSequence}`]
  );
  return Number(result.rows[0].id);
}

async function createLead(client, { contactId, branchName = null } = {}) {
  const id = contactId || await createContact(client);
  const result = await client.query(
    `INSERT INTO leads (contact_id, branch_name, created_by)
     VALUES ($1, $2, 'Automation')
     RETURNING id, contact_id, branch_name, owner_username, owner_assignment_source`,
    [id, branchName]
  );
  return result.rows[0];
}

test(
  "automatic lead distribution executes correctly in PostgreSQL",
  { skip: !TEST_DATABASE_URL },
  async (t) => {
    const schemaName = `lead_distribution_it_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await admin.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);

    t.after(async () => {
      await admin.query("SET search_path TO public").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`).catch(() => {});
      await admin.end().catch(() => {});
    });

    for (const relativePath of schemaFiles) {
      const sql = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
      await admin.query(sql);
    }

    await admin.query(
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

    await t.test("global round robin advances and wraps", async () => {
      await resetFixtures(admin);
      await seedSales(admin, [
        { username: "sales_a", branch: "Puchong" },
        { username: "sales_b", branch: "Kuala Lumpur" },
      ]);

      const leads = [];
      for (let index = 0; index < 4; index += 1) {
        leads.push(await createLead(admin));
      }

      assert.deepEqual(
        leads.map((lead) => lead.owner_username),
        ["sales_a", "sales_b", "sales_a", "sales_b"]
      );
      assert.ok(leads.every((lead) => lead.owner_assignment_source === "automatic"));
    });

    await t.test("known branches use their own pools and branch edits keep the owner stable", async () => {
      await resetFixtures(admin);
      await seedSales(admin, [
        { username: "puchong_a", branch: "Puchong" },
        { username: "puchong_b", branch: "Puchong" },
        { username: "kl_only", branch: "Kuala Lumpur" },
      ]);

      const first = await createLead(admin, { branchName: "Puchong" });
      const second = await createLead(admin, { branchName: "Puchong" });
      const kl = await createLead(admin, { branchName: "Kuala Lumpur" });

      assert.equal(first.owner_username, "puchong_a");
      assert.equal(second.owner_username, "puchong_b");
      assert.equal(kl.owner_username, "kl_only");

      const changed = await admin.query(
        `UPDATE leads
         SET branch_name = 'Kuala Lumpur'
         WHERE id = $1
         RETURNING owner_username, branch_name, owner_assignment_source`,
        [first.id]
      );
      assert.equal(changed.rows[0].owner_username, "puchong_a");
      assert.equal(changed.rows[0].branch_name, "Kuala Lumpur");
      assert.equal(changed.rows[0].owner_assignment_source, "automatic");
    });

    await t.test("recovery assigns only never-owned leads and respects manual unassignment", async () => {
      await resetFixtures(admin);
      await seedSales(admin, [
        { username: "sales_a", branch: "Puchong" },
        { username: "sales_b", branch: "Puchong", active: false },
      ]);

      const manuallyCleared = await createLead(admin);
      assert.equal(manuallyCleared.owner_username, "sales_a");

      const cleared = await admin.query(
        `UPDATE leads
         SET owner_username = NULL
         WHERE id = $1
         RETURNING owner_username, owner_assignment_source`,
        [manuallyCleared.id]
      );
      assert.equal(cleared.rows[0].owner_username, null);
      assert.equal(cleared.rows[0].owner_assignment_source, "manual");

      await admin.query("UPDATE users SET is_active = false WHERE username = 'sales_a'");
      const neverOwned = await createLead(admin);
      assert.equal(neverOwned.owner_username, null);
      assert.equal(neverOwned.owner_assignment_source, null);

      await admin.query("UPDATE users SET is_active = true WHERE username = 'sales_a'");
      const recovered = await admin.query(
        "SELECT recover_unassigned_open_leads(100) AS count"
      );
      assert.equal(Number(recovered.rows[0].count), 1);

      const rows = await admin.query(
        `SELECT id, owner_username, owner_assignment_source
         FROM leads
         WHERE id = ANY($1::int[])
         ORDER BY id`,
        [[manuallyCleared.id, neverOwned.id]]
      );
      assert.deepEqual(rows.rows, [
        {
          id: Number(manuallyCleared.id),
          owner_username: null,
          owner_assignment_source: "manual",
        },
        {
          id: Number(neverOwned.id),
          owner_username: "sales_a",
          owner_assignment_source: "automatic",
        },
      ]);
    });

    await t.test("concurrent lead inserts remain balanced through the persisted cursor", async () => {
      await resetFixtures(admin);
      await seedSales(admin, [
        { username: "sales_a" },
        { username: "sales_b" },
      ]);

      const contactIds = [];
      for (let index = 0; index < 10; index += 1) {
        contactIds.push(await createContact(admin));
      }

      const clients = await Promise.all(
        contactIds.map(() => connectToTestSchema(schemaName))
      );
      t.after(async () => {
        await Promise.all(clients.map((client) => client.end().catch(() => {})));
      });

      const inserted = await Promise.all(
        clients.map((client, index) => createLead(client, { contactId: contactIds[index] }))
      );

      const counts = inserted.reduce((acc, lead) => {
        acc[lead.owner_username] = (acc[lead.owner_username] || 0) + 1;
        return acc;
      }, {});
      assert.deepEqual(counts, { sales_a: 5, sales_b: 5 });
      assert.ok(inserted.every((lead) => lead.owner_assignment_source === "automatic"));
    });
  }
);
