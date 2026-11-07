"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const clinicConfig = require("../src/config/clinicConfig");
const { customerFollowUpIntentGuardSql } = require("../src/db/followUpRepo");

test("Neutro primary follow-up guard keeps staff answer and booking checks distinct", () => {
  const originalType = clinicConfig.businessType;
  const originalName = clinicConfig.businessName;
  try {
    clinicConfig.businessType = "tcm_clinic";
    clinicConfig.businessName = "Neutro Sense TCM Centre";
    const sql = customerFollowUpIntentGuardSql("c");
    assert.match(sql, /anchor\.sent_by_username IS NULL/);
    assert.match(sql, /appointmentOnly: true/); // older verified staff booking holds
    assert.match(sql, /staff_anchor\.id = anchor\.id/);
    assert.match(sql, /booking_customer\.role = 'user'/);
    assert.match(sql, /staff_appointment_reminder/);
    assert.match(sql, /staff_reminder_invalidated/);
    assert.match(sql, /health\[\[:space:\]\]\+professional/);
  } finally {
    clinicConfig.businessType = originalType;
    clinicConfig.businessName = originalName;
  }
});

test("answered staff enquiry resumes sales follow-up, but booking remains protected in PostgreSQL", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = "staff_fu_" + process.pid + "_" + Date.now();
  const originalType = clinicConfig.businessType;
  const originalName = clinicConfig.businessName;
  let created = false;
  await db.connect();
  try {
    clinicConfig.businessType = "tcm_clinic";
    clinicConfig.businessName = "Neutro Sense TCM Centre";
    const guard = customerFollowUpIntentGuardSql("c");
    await db.query('CREATE SCHEMA "' + schema + '"');
    created = true;
    await db.query('SET search_path TO "' + schema + '"');
    await db.query([
      "CREATE TABLE contacts(id INT PRIMARY KEY,channel TEXT NOT NULL DEFAULT 'whatsapp');",
      "CREATE TABLE leads(id INT PRIMARY KEY,contact_id INT);",
      "CREATE TABLE lead_activities(id SERIAL PRIMARY KEY,lead_id INT,metadata JSONB);",
      "CREATE TABLE messages(id INT PRIMARY KEY, contact_id INT, role TEXT, content TEXT, sent_by_username TEXT, whatsapp_message_id TEXT, delivery_status TEXT, media_mime_type TEXT, is_automated_follow_up BOOLEAN DEFAULT FALSE, is_forwarded BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL);",
      "INSERT INTO contacts(id) SELECT n FROM generate_series(1,7) n;",
      "INSERT INTO leads(id,contact_id) VALUES(50,5);",
    ].join("\n"));

    const add = async (id, contact, role, text, minutesAgo, staff = false) => {
      await db.query(
        "INSERT INTO messages (id,contact_id,role,content,sent_by_username,whatsapp_message_id,delivery_status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now()-$8::int*interval '1 minute')",
        [id, contact, role, text, staff ? "admin" : null,
          "wamid." + id, staff ? "delivered" : null, minutesAgo]
      );
    };

    // Reproduce #8957: an old staff question is answered by a newer staff
    // treatment explanation. The old question must not block that new cycle.
    await add(101,1,"user","Hi",210);
    await add(102,1,"assistant","May I check which treatment you are asking about?",200,true);
    await add(103,1,"user","i ask previously",199);
    await add(104,1,"assistant","Regarding facial care, we offer 3D and 9D. Which concern would you like to improve?",160,true);

    // A booking enquiry remains staff-owned even if a newer staff message
    // follows the customer's yes.
    await add(201,2,"user","Can I book an appointment?",130);
    await add(202,2,"assistant","Can you come tomorrow at 3pm?",120,true);
    await add(203,2,"user","Yes",119);
    await add(204,2,"assistant","Your appointment is confirmed for tomorrow at 3pm",90,true);

    // The first staff answer after a customer's booking request must not be
    // misclassified as a follow-up opportunity merely because no lead is booked.
    await add(301,3,"user","Can I book a visit?",130);
    await add(302,3,"assistant","Tomorrow 3pm?",120,true);

    // A generic "book now" advertisement is NOT a verified booking discussion.
    await add(401,4,"user","What is 3D?",130);
    await add(402,4,"assistant","Our promotion is available, book now!",120,true);

    // A durable staff reminder before the latest customer turn remains on hold
    // even if a later staff message doesn't say the word appointment.
    await add(501,5,"user","hi",130);
    await add(502,5,"assistant","See you soon",120,true);
    await add(503,5,"user","ok",119);
    await add(504,5,"assistant","Is your time still okay?",90,true);
    await db.query("INSERT INTO lead_activities(lead_id,metadata) VALUES(50,$1::jsonb)", [
      JSON.stringify({outcome:"staff_appointment_reminder",staffMessageId:"502"})
    ]);

    // Existing broad staff protection still applies to an AI-authored anchor.
    await add(601,6,"user","hi",130);
    await add(602,6,"assistant","May I check which treatment?",120,true);
    await add(603,6,"user","i ask previously",119);
    await add(604,6,"assistant","We offer 3D and 9D",90,false);

    await add(701,7,"user","I want a business collaboration",130);
    await add(702,7,"assistant","Please contact our team",120,true);

    const check = async (contactId, inboundId, anchorId) => {
      const { rows } = await db.query(
        "SELECT " + guard + " AS eligible FROM contacts c JOIN messages latest_inbound ON latest_inbound.contact_id=c.id AND latest_inbound.id=$2 JOIN messages anchor ON anchor.contact_id=c.id AND anchor.id=$3 WHERE c.id=$1",
        [contactId,inboundId,anchorId]
      );
      return rows[0].eligible;
    };

    assert.equal(await check(1,103,104), true, "answered facial enquiry follows up");
    assert.equal(await check(2,203,204), false, "existing booking conversation protected");
    assert.equal(await check(3,301,302), false, "new appointment proposal protected");
    assert.equal(await check(4,401,402), true, "generic booking CTA is not ownership");
    assert.equal(await check(5,503,504), false, "verified reminder protected");
    assert.equal(await check(6,603,604), false, "AI anchor retains old staff guard");
    assert.equal(await check(7,701,702), false, "commercial enquiries remain excluded");

    await db.query("INSERT INTO lead_activities(lead_id,metadata) VALUES(50,$1::jsonb)", [
      JSON.stringify({outcome:"staff_reminder_invalidated",staffMessageId:"502"})
    ]);
    assert.equal(await check(5,503,504), true, "invalidated reminder releases hold");
  } finally {
    clinicConfig.businessType = originalType;
    clinicConfig.businessName = originalName;
    await db.query("SET search_path TO public").catch(() => {});
    if (created) await db.query('DROP SCHEMA "' + schema + '" CASCADE').catch(() => {});
    await db.end();
  }
});
