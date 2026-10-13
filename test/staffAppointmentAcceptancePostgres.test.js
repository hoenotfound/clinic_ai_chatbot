const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const {
  createStaffAppointmentAcceptanceService,
} = require("../src/services/staffAppointmentAcceptanceService");

const databaseUrl = process.env.TEST_DATABASE_URL;

test("Postgres accepts only the latest recent verified staff offer, preserves confirmed bookings and queues one alert", {
  skip: !databaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const schema = "staff_accept_" + process.pid + "_" + Date.now();
  let created = false;
  const alerts = [];
  try {
    await client.query("CREATE SCHEMA " + schema);
    created = true;
    await client.query("SET search_path TO " + schema);
    await client.query([
      "CREATE TABLE contacts (id INT PRIMARY KEY, mode TEXT, needs_attention BOOLEAN DEFAULT false, attention_reason TEXT, updated_at TIMESTAMPTZ DEFAULT now());",
      "CREATE TABLE messages (id INT PRIMARY KEY, contact_id INT, role TEXT, content TEXT, sent_by_username TEXT, is_automated_follow_up BOOLEAN DEFAULT false, delivery_status TEXT, whatsapp_message_id TEXT, created_at TIMESTAMPTZ DEFAULT now());",
      "CREATE TABLE leads (id INT PRIMARY KEY, contact_id INT, appointment_status TEXT, appointment_at TIMESTAMPTZ, stage_id INT, is_closed BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());",
      "CREATE TABLE lead_activities (id SERIAL PRIMARY KEY, lead_id INT, activity_type TEXT, description TEXT, actor TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT now());",
      "CREATE TABLE ai_review_items (contact_id INT, status TEXT, category TEXT);",
      "INSERT INTO contacts (id, mode) VALUES (372, 'ai');",
      "INSERT INTO leads (id, contact_id, appointment_status, appointment_at, stage_id) VALUES (116, 372, 'set', '2026-10-17T07:30:00Z', 3);",
      "INSERT INTO messages (id, contact_id, role, content, sent_by_username, whatsapp_message_id, delivery_status) VALUES (1475, 372, 'assistant', 'Hi 你好，星期六，4点的时间你方便吗？', 'clinic-staff', 'wamid.1475', 'delivered');",
      "INSERT INTO messages (id, contact_id, role, content) VALUES (1476, 372, 'user', 'Ok');",
    ].join("\n"));

    const service = createStaffAppointmentAcceptanceService({
      database: { connect: async () => ({ query: client.query.bind(client), release() {} }) },
      lockContactAlertQueue: async () => {},
      sendBookingReadyAlert: async (input) => { alerts.push(input); return { status: "queued" }; },
      wakeAlertQueue: () => {},
      sendWebPush: () => {},
      publish: () => {},
    });
    const accepted = await service(372, 1476, "Ok");
    assert.equal(accepted.leadId, 116);
    const lead = (await client.query("SELECT appointment_status, appointment_at FROM leads WHERE id=116")).rows[0];
    assert.equal(lead.appointment_status, "set");
    assert.equal(new Date(lead.appointment_at).toISOString(), "2026-10-17T07:30:00.000Z");
    assert.equal(alerts.length, 1);
    const contact = (await client.query("SELECT needs_attention, attention_reason FROM contacts WHERE id=372")).rows[0];
    assert.equal(contact.needs_attention, true);
    assert.match(contact.attention_reason, /Booking ready:/);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM lead_activities")).rows[0].n, 1);
    assert.equal(await service(372, 1476, "Ok"), null);
    assert.equal(alerts.length, 1);

    // A later customer acknowledgement must not accept that older staff offer.
    await client.query("INSERT INTO messages (id, contact_id, role, content) VALUES (1477, 372, 'user', 'Thanks'), (1478, 372, 'user', 'Ok')");
    assert.equal(await service(372, 1478, "Ok"), null);
    assert.equal(alerts.length, 1);
    // An intervening unrelated assistant answer also blocks stale inference.
    await client.query("INSERT INTO messages (id, contact_id, role, content) VALUES (1479, 372, 'assistant', 'You are welcome'), (1480, 372, 'user', 'Ok')");
    assert.equal(await service(372, 1480, "Ok"), null);
  } finally {
    try {
      if (created) {
        await client.query("SET search_path TO public");
        await client.query("DROP SCHEMA " + schema + " CASCADE");
      }
    } finally {
      client.release();
      await pool.end();
    }
  }
});
