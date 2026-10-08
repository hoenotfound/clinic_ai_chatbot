const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const { pool } = require("../src/db/db");
const pricingRepo = require("../src/db/pricingReminderRepo");

test("pricing reminder is atomically claimed without advancing regular steps", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `pricing_reminder_${process.pid}_${Date.now()}`;
  const originalQuery = pool.query;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY, channel TEXT NOT NULL, whatsapp_number TEXT,
        needs_attention BOOLEAN NOT NULL DEFAULT false,
        mode TEXT NOT NULL DEFAULT 'ai',
        whatsapp_opt_out_at TIMESTAMPTZ,
        whatsapp_marketing_opt_out_at TIMESTAMPTZ
      );
      CREATE TABLE pipeline_stages (id INTEGER PRIMARY KEY, stage_type TEXT, system_key TEXT);
      CREATE TABLE leads (
        id SERIAL PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id),
        stage_id INTEGER REFERENCES pipeline_stages(id), treatment_interest TEXT,
        is_closed BOOLEAN NOT NULL DEFAULT false, appointment_status TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE messages (
        id SERIAL PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id),
        role TEXT NOT NULL, content TEXT NOT NULL, whatsapp_message_id TEXT,
        sent_by_username TEXT, media_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivery_status TEXT, is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
        automated_follow_up_for_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        automated_follow_up_step INTEGER NOT NULL DEFAULT 1,
        automated_follow_up_target_service TEXT,
        automated_follow_up_targeting_recorded BOOLEAN NOT NULL DEFAULT false,
        automated_follow_up_message_mode TEXT,
        CONSTRAINT messages_automated_follow_up_step_check
          CHECK (automated_follow_up_step BETWEEN 1 AND 3),
        UNIQUE (automated_follow_up_for_message_id, automated_follow_up_step)
      );
      CREATE TABLE outbound_message_evidence (
        message_id INTEGER REFERENCES messages(id), origin TEXT
      );
      CREATE TABLE follow_up_ai_decisions (
        contact_id INTEGER, trigger_message_id INTEGER, action TEXT
      );
    `);

    // Verify the exact production migration is applicable to the current schema.
    await client.query(fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/047_conditional_pricing_reminder.sql"),
      "utf8"
    ));

    await client.query(`
      INSERT INTO contacts (id,channel,whatsapp_number)
      VALUES (1,'whatsapp','60123456789');
      INSERT INTO leads (contact_id,treatment_interest) VALUES (1,'3D 小颜术');
      INSERT INTO messages (id,contact_id,role,content,created_at)
        VALUES (100,1,'user','3D treatment please',now()-interval '12 hours');
      INSERT INTO messages (id,contact_id,role,content,created_at)
        VALUES (101,1,'assistant','Here are details',now()-interval '11 hours');
      INSERT INTO messages (id,contact_id,role,content,created_at,delivery_status,
        is_automated_follow_up,automated_follow_up_for_message_id,automated_follow_up_step)
        VALUES (102,1,'assistant','First reminder',now()-interval '8 hours',
          'delivered',true,101,1);
      INSERT INTO messages (id,contact_id,role,content,created_at,delivery_status,
        is_automated_follow_up,automated_follow_up_for_message_id,automated_follow_up_step)
        VALUES (103,1,'assistant','Video',now()-interval '5 hours',
          'delivered',true,101,2);
    `);
    pool.query = client.query.bind(client);
    const activatedAt = new Date(Date.now() - 86400000).toISOString();
    const settings = {
      steps: [
        { delayMinutes: 120, timingMode: "after_reply", beforeWindowExpiryMinutes: 120 },
        { delayMinutes: 360, timingMode: "after_reply", beforeWindowExpiryMinutes: 120 },
        { delayMinutes: 1320, timingMode: "before_window_expiry", beforeWindowExpiryMinutes: 120 }
      ],
      quietHours: { enabled: false, start: "00:00", end: "07:00" },
    };
    // Follow-up 2 cannot trigger a price image, even when Meta accepts it.
    await client.query("UPDATE messages SET delivery_status='pending', whatsapp_message_id='wamid.step2' WHERE id=103");
    assert.equal((await pricingRepo.listEligible({ activatedAt, triggerMode: "all", settings })).length,0);

    // A failed final testimonial must not trigger the price graphic.
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,delivery_status,
       is_automated_follow_up,automated_follow_up_for_message_id,automated_follow_up_step)
      VALUES (104,1,'assistant','Final testimonial',now()-interval '10 minutes','failed',true,101,3)`);
    assert.equal((await pricingRepo.listEligible({ activatedAt, triggerMode: "all", settings })).length,0);

    // Pending+WAMID means the real third message was accepted by Meta.
    await client.query("UPDATE messages SET delivery_status='pending',whatsapp_message_id='wamid.final' WHERE id=104");
    const candidates = await pricingRepo.listEligible({ activatedAt, triggerMode: "all", settings });
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate.third_id,104);
    const offer = {
      caption:"Our 3D price is RM488", imageUrl:"https://example.com/promo-images/30",
      serviceName:"3D 小颜术", identities:["/promo-images/30"],
    };
    const saved = await pricingRepo.claim({ candidate, offer, activatedAt, triggerMode:"all", settings });
    assert.ok(saved);
    assert.equal(saved.content, offer.caption);
    assert.equal(await pricingRepo.isClaimStillEligible({
      messageId:saved.id,contactId:1,anchorId:101,inboundId:100,
      imageIdentities:offer.identities, treatmentInterest:candidate.treatment_interest,
      thirdId:candidate.third_id, whatsappNumber:candidate.whatsapp_number,
    }), true);
    assert.equal(await pricingRepo.claim({candidate,offer,activatedAt,triggerMode:"all",settings}), null);

    const progress = await client.query(
      "SELECT MAX(automated_follow_up_step) AS step FROM messages WHERE automated_follow_up_for_message_id=101"
    );
    assert.equal(progress.rows[0].step, 3);

    await client.query("UPDATE leads SET appointment_status='set' WHERE contact_id=1");
    assert.equal(await pricingRepo.isClaimStillEligible({
      messageId:saved.id,contactId:1,anchorId:101,inboundId:100,
      imageIdentities:offer.identities, treatmentInterest:candidate.treatment_interest,
      thirdId:candidate.third_id, whatsappNumber:candidate.whatsapp_number,
    }), false);

    // Editing the CRM interest while the message is queued must stop sending.
    await client.query("UPDATE leads SET appointment_status='none', treatment_interest='9D 逆龄抗衰' WHERE contact_id=1");
    assert.equal(await pricingRepo.isClaimStillEligible({
      messageId:saved.id, contactId:1, anchorId:101, inboundId:100,
      imageIdentities:offer.identities, treatmentInterest:candidate.treatment_interest,
      thirdId:candidate.third_id, whatsappNumber:candidate.whatsapp_number,
    }), false);

    // Verify the unique decision record and avoid repeated human-review alerts.
    await client.query("DELETE FROM messages WHERE id=$1", [saved.id]);
    await client.query("UPDATE leads SET treatment_interest='3D 小颜术' WHERE contact_id=1");
    // Staff takeover and marketing opt-outs must never become candidates.
    await client.query("UPDATE contacts SET mode='human' WHERE id=1");
    assert.equal((await pricingRepo.listEligible({ activatedAt,triggerMode:"all",settings })).length, 0);
    await client.query("UPDATE contacts SET mode='ai', whatsapp_marketing_opt_out_at=now() WHERE id=1");
    assert.equal((await pricingRepo.listEligible({ activatedAt,triggerMode:"all",settings })).length, 0);
    await client.query("UPDATE contacts SET whatsapp_marketing_opt_out_at=NULL WHERE id=1");

    const reviewDecision = await pricingRepo.recordDecision({
      candidate, reason:"delivery_review",
    });
    assert.ok(reviewDecision);
    assert.equal(await pricingRepo.recordDecision({
      candidate, reason:"delivery_review",
    }), null);
    assert.equal(await pricingRepo.claim({
      candidate,offer,activatedAt,triggerMode:"all",settings,
    }), null);
    await client.query("DELETE FROM pricing_reminder_decisions WHERE anchor_id=101");

    // A testimonial sent too late cannot fit five minutes before expiry.
    await client.query(`
      UPDATE messages SET created_at=now()-interval '23 hours 47 minutes' WHERE id=100;
      UPDATE messages SET created_at=now()-interval '23 hours 45 minutes' WHERE id=101;
      UPDATE messages SET created_at=now()-interval '1 minute' WHERE id=104;
    `);
    const crowdedCandidates = await pricingRepo.listEligible({
      activatedAt,triggerMode:"all",settings,
    });
    assert.equal(crowdedCandidates.length,0);

    // The pricing reminder must not keep the original message undeletable.
    await client.query("DELETE FROM messages WHERE id=101");
    const rowsAfterDelete = await client.query(
      "SELECT id FROM messages WHERE id=$1 OR pricing_reminder_anchor_id=$1", [101]
    );
    assert.equal(rowsAfterDelete.rowCount, 0);
  } finally {
    pool.query = originalQuery;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
