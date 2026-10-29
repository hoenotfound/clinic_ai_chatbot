const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { pool } = require("../src/db/db");
const { listPending, recordOutcome, undoOutcome, listRecentCorrections, countMonthlyOutcomes } = require("../src/db/salesFollowUpRepo");

const URL = process.env.TEST_DATABASE_URL;
const files = [
  "src/db/schema.sql",
  "src/db/whatsappPolicySchema.sql",
  "src/db/migrations/024_whatsapp_marketing_opt_out.sql",
  "src/db/migrations/054_whatsapp_free_entry_followups.sql",
  "src/db/migrations/057_whatsapp_free_entry_referrals.sql",
  "src/db/migrations/078_sales_follow_up_tasks.sql",
  "src/db/migrations/079_sales_follow_up_corrections.sql"
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
    // This isolated fixture predates WhatsApp coexistence. The production
    // history table is created by migration 099; supply its lookup shape here.
    await client.query(`
      CREATE TABLE whatsapp_sender_coexistence_history_messages (
        message_id INTEGER PRIMARY KEY
      )
    `);
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
    await client.query("UPDATE leads SET marketing_consent='opted_in' WHERE id=$1", [leadId]);
    async function pending(username="sales-a") {
      return listPending({ username, queryable: client, now: NOW });
    }
    assert.equal((await pending()).length, 1);
    // Old WhatsApp Business App history is never eligible for sales outreach.
    await client.query(
      "INSERT INTO whatsapp_sender_coexistence_history_messages(message_id) VALUES ($1)",
      [inbound.rows[0].id]
    );
    assert.equal((await pending()).length, 0);
    await client.query(
      "DELETE FROM whatsapp_sender_coexistence_history_messages WHERE message_id=$1",
      [inbound.rows[0].id]
    );
    assert.equal((await pending()).length, 1);
    assert.equal((await pending("other-salesperson")).length, 0);
    // A Sales account with view_all_leads can manage eligible unassigned
    // contacts just as it can in Inbox and Pipeline.
    await client.query("UPDATE leads SET owner_username=NULL WHERE id=$1", [leadId]);
    assert.equal((await pending()).length, 0);
    assert.equal((await listPending({
      username: "other-salesperson", canViewAll: true, queryable: client, now: NOW
    })).length, 1);
    await client.query("UPDATE leads SET owner_username='sales-a' WHERE id=$1", [leadId]);

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

    // End-to-end correction is time-limited, verified against latest inbound
    // and restores earlier task, stage and appointment state atomically.
    await client.query("UPDATE contacts SET whatsapp_opt_out_at=NULL WHERE id=$1", [contactId]);
    const originalConnect = pool.connect;
    const originalQuery = pool.query;
    pool.connect = async () => ({ query: client.query.bind(client), release() {} });
    pool.query = client.query.bind(client);
    t.after(() => { pool.connect = originalConnect; pool.query = originalQuery; });

    const outcome = await recordOutcome({
      leadId, expectedLastInboundId: inbound.rows[0].id,
      status: "not_interested", username:"sales-a", now:new Date()
    });
    assert.ok(outcome.eventId);
    assert.equal((await pending()).length,0);
    const recent=await listRecentCorrections({ username:"sales-a", queryable:client });
    assert.equal(Number(recent[0].eventId),outcome.eventId);
    await assert.rejects(
      undoOutcome({leadId,eventId:outcome.eventId,username:"other-salesperson"}),
      err=>err.status===403
    );

    const changed=await client.query(
      "INSERT INTO messages (contact_id,role,content) VALUES ($1,'user','New customer reply') RETURNING id",
      [contactId]
    );
    await assert.rejects(
      undoOutcome({leadId,eventId:outcome.eventId,username:"sales-a"}),
      err=>err.status===409
    );
    await client.query("DELETE FROM messages WHERE id=$1",[changed.rows[0].id]);
    await undoOutcome({leadId,eventId:outcome.eventId,username:"sales-a"});
    assert.equal((await pending()).length,1);
    assert.equal((await listRecentCorrections({username:"sales-a",queryable:client})).length,0);

    const apptBefore=(await client.query(
      "SELECT stage_id,appointment_status,appointment_at FROM leads WHERE id=$1",[leadId]
    )).rows[0];
    const originalAttentionReason = "Booking ready: Customer requested an appointment";
    await client.query(
      "UPDATE contacts SET needs_attention=true, attention_reason=$2, updated_at=now() WHERE id=$1",
      [contactId, originalAttentionReason]
    );
    const booking=await recordOutcome({
      leadId, expectedLastInboundId:inbound.rows[0].id,
      status:"booked",dueAt:new Date(Date.now()+86400000).toISOString(),
      username:"sales-a"
    });
    const booked=(await client.query(
      "SELECT appointment_status FROM leads WHERE id=$1",[leadId]
    )).rows[0];
    assert.equal(booked.appointment_status,"set");
    const afterBooking = (await client.query(
      "SELECT needs_attention, attention_reason FROM contacts WHERE id=$1", [contactId]
    )).rows[0];
    assert.equal(afterBooking.needs_attention, false);
    assert.equal(afterBooking.attention_reason, null);
    await undoOutcome({leadId,eventId:booking.eventId,username:"sales-a"});
    const restored=(await client.query(
      "SELECT stage_id,appointment_status,appointment_at FROM leads WHERE id=$1",[leadId]
    )).rows[0];
    assert.equal(restored.stage_id,apptBefore.stage_id);
    assert.equal(restored.appointment_status,apptBefore.appointment_status);
    assert.equal(String(restored.appointment_at),String(apptBefore.appointment_at));
    const restoredAttention=(await client.query(
      "SELECT needs_attention, attention_reason FROM contacts WHERE id=$1", [contactId]
    )).rows[0];
    assert.equal(restoredAttention.needs_attention,true);
    assert.equal(restoredAttention.attention_reason,originalAttentionReason);
    const totals=await countMonthlyOutcomes({username:"sales-a",queryable:client});
    assert.equal(totals.booked,0);
    assert.equal(totals.not_interested,0);

    // A staff update or newly raised alert must win over a stale Undo.
    const secondBooking=await recordOutcome({
      leadId, expectedLastInboundId:inbound.rows[0].id,
      status:"booked", dueAt:new Date(Date.now()+2*86400000).toISOString(),
      username:"sales-a"
    });
    await client.query(
      "UPDATE contacts SET needs_attention=true, attention_reason='Staff review: new issue', updated_at=now() WHERE id=$1",
      [contactId]
    );
    await assert.rejects(
      undoOutcome({leadId,eventId:secondBooking.eventId,username:"sales-a"}),
      err=>err.status===409 && /Inbox attention changed/.test(err.message)
    );
    const stillBooked=(await client.query(
      "SELECT appointment_status FROM leads WHERE id=$1", [leadId]
    )).rows[0];
    assert.equal(stillBooked.appointment_status,"set");
    const newAttention=(await client.query(
      "SELECT needs_attention,attention_reason FROM contacts WHERE id=$1", [contactId]
    )).rows[0];
    assert.equal(newAttention.needs_attention,true);
    assert.equal(newAttention.attention_reason,"Staff review: new issue");
  });
