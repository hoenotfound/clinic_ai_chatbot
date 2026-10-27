const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { listPending } = require("../src/db/salesFollowUpRepo");

const URL = process.env.TEST_DATABASE_URL;
const files = [
  "src/db/schema.sql",
  "src/db/whatsappPolicySchema.sql",
  "src/db/migrations/024_whatsapp_marketing_opt_out.sql",
  "src/db/migrations/054_whatsapp_free_entry_followups.sql",
  "src/db/migrations/057_whatsapp_free_entry_referrals.sql",
  "src/db/migrations/078_sales_follow_up_tasks.sql"
];
const NOW = new Date("2026-10-27T08:00:00Z");

test("PostgreSQL follow-up selection respects 48h, ownership, saved outcome and opt-outs",
  { skip: !URL }, async (t) => {
    const schema = "sales_fu_" + process.pid + "_" + Date.now();
    const escaped = '"' + schema.replaceAll('"','""') + '"';
    const client = new Client({ connectionString: URL, ssl: false });
    await client.connect();
    t.after(async () => {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query("DROP SCHEMA IF EXISTS " + escaped + " CASCADE").catch(() => {});
      await client.end().catch(() => {});
    });
    await client.query("CREATE SCHEMA " + escaped);
    await client.query("SET search_path TO " + escaped + ",public");
    for (const file of files) {
      await client.query(fs.readFileSync(path.join(__dirname, "..", file), "utf8"));
    }
    const contact = await client.query(
      "INSERT INTO contacts (whatsapp_number, name, whatsapp_opt_in_at, whatsapp_opt_in_source) VALUES ('60123456789','Example','2026-10-01T00:00:00Z','customer_request') RETURNING id"
    );
    const contactId = contact.rows[0].id;
    const inbound = await client.query(
      "INSERT INTO messages (contact_id,role,content,created_at) VALUES ($1,'user','3D 小颜术 price?','2026-10-24T08:00:00Z') RETURNING id",
      [contactId]
    );
    const stage = await client.query("SELECT id FROM pipeline_stages WHERE system_key='new' LIMIT 1");
    const lead = await client.query(
      "INSERT INTO leads (contact_id,stage_id,started_message_id,temperature,treatment_interest,owner_username) VALUES ($1,$2,$3,'hot','3D 小颜术','sales-a') RETURNING id",
      [contactId,stage.rows[0].id,inbound.rows[0].id]
    );
    const leadId = lead.rows[0].id;
    async function pending(username="sales-a") {
      return listPending({ username, queryable: client, now: NOW });
    }
    assert.equal((await pending()).length, 1);
    assert.equal((await pending("other-salesperson")).length, 0);

    // Verified CTWA customers must NOT be offered for personal follow-up
    // before the next *unclaimed* 66-hour automated marketing slot.
    const clinicConfig = require("../src/config/clinicConfig");
    const originalConfig = clinicConfig.automatedFollowUp;
    const originalFlag = process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED;
    try {
      clinicConfig.automatedFollowUp = {
        enabled: true,
        freeEntry: { enabled: true, activatedAt: "2026-10-23T00:00:00Z",
          slotsHours: [26, 50, 66] }
      };
      process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED = "true";
      const reply = await client.query(
        "INSERT INTO messages (contact_id,role,content,whatsapp_message_id,created_at) VALUES ($1,'assistant','Reply','wamid.sales-fep','2026-10-24T08:05:00Z') RETURNING id",
        [contactId]
      );
      await client.query(
        "INSERT INTO whatsapp_free_entry_referrals (origin_message_id,contact_id,ctwa_clid,source_type) VALUES ($1,$2,'click-123','ad')",
        [inbound.rows[0].id,contactId]
      );
      await client.query(
        "INSERT INTO whatsapp_free_entry_pricing_evidence (wamid,pricing_type,billable,delivery_status) VALUES ('wamid.sales-fep','free_entry_point',false,'sent')"
      );
      assert.equal((await pending()).length, 0, "no attempt yet, but a future AI send remains scheduled");
      clinicConfig.automatedFollowUp.freeEntry.enabled = false;
      assert.equal((await pending()).length, 1);
    } finally {
      clinicConfig.automatedFollowUp = originalConfig;
      if (originalFlag === undefined) delete process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED;
      else process.env.WHATSAPP_FEP_FOLLOWUPS_ENABLED = originalFlag;
    }

    await client.query(
      "INSERT INTO sales_follow_up_tasks (lead_id,status,last_inbound_id,updated_by) VALUES ($1,'contacted',$2,'sales-a')",
      [leadId,inbound.rows[0].id]
    );
    assert.equal((await pending()).length, 0);

    await client.query(
      "UPDATE sales_follow_up_tasks SET status='later',due_at='2026-10-28T08:00:00Z' WHERE lead_id=$1",
      [leadId]
    );
    assert.equal((await pending()).length, 0);
    await client.query(
      "UPDATE sales_follow_up_tasks SET due_at='2026-10-27T08:00:00Z' WHERE lead_id=$1",
      [leadId]
    );
    assert.equal((await pending()).length, 1);

    await client.query("UPDATE contacts SET whatsapp_opt_out_at='2026-10-26T08:00:00Z' WHERE id=$1", [contactId]);
    assert.equal((await pending()).length, 0);
  });
