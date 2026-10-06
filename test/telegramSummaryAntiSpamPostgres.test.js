const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const { pool } = require("../src/db/db");
const telegramAlertRepo = require("../src/db/telegramAlertRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "conversation-summary anti-spam gating works against Postgres",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `telegram_summary_antispam_${process.pid}_${Date.now()}`;
    const originalQuery = pool.query;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          whatsapp_number TEXT,
          name TEXT,
          whatsapp_profile_name TEXT,
          channel TEXT,
          channel_user_id TEXT
        );

        CREATE TABLE pipeline_stages (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );

        CREATE TABLE users (
          username TEXT PRIMARY KEY,
          display_name TEXT
        );

        CREATE TABLE leads (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          temperature TEXT,
          branch_name TEXT,
          treatment_interest TEXT,
          appointment_at TIMESTAMPTZ,
          appointment_status TEXT,
          stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id),
          owner_username TEXT
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE telegram_summary_alerts (
          id INTEGER PRIMARY KEY,
          lead_id INTEGER NOT NULL REFERENCES leads(id),
          through_message_id INTEGER NOT NULL,
          score_data JSONB NOT NULL DEFAULT '{}'::jsonb,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          claimed_at TIMESTAMPTZ,
          sent_at TIMESTAMPTZ,
          error_text TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE telegram_immediate_alerts (
          id INTEGER PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          lead_id INTEGER REFERENCES leads(id),
          alert_type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        INSERT INTO contacts (
          id, whatsapp_number, whatsapp_profile_name, channel
        ) VALUES (12, '60123456789', 'Kit Leong', 'whatsapp');

        INSERT INTO pipeline_stages (id, name) VALUES (1, 'Contacted');

        INSERT INTO leads (
          id, contact_id, temperature, stage_id, appointment_status
        ) VALUES (7, 12, 'hot', 1, 'none');

        INSERT INTO messages (id, contact_id, role, created_at)
        VALUES (44, 12, 'user', now() - interval '20 minutes');

        INSERT INTO telegram_summary_alerts (
          id, lead_id, through_message_id, score_data, created_at
        ) VALUES (
          31,
          7,
          44,
          '{"temperature":"hot","summary":{"chatSummary":"Customer is ready to book."}}'::jsonb,
          now()
        );

        INSERT INTO telegram_immediate_alerts (
          id, contact_id, lead_id, alert_type, status, created_at
        ) VALUES (80, 12, 7, 'booking_ready', 'pending', now());
      `);

      pool.query = (...args) => client.query(...args);

      // A queued actionable alert owns the episode, so the normal summary waits.
      assert.deepEqual(
        await telegramAlertRepo.findReadySummaries({
          inactivityMinutes: 10,
          limit: 5,
        }),
        []
      );

      // A previously failed normal summary must not keep waking the worker while
      // a primary actionable alert still owns the episode.
      await client.query(
        "UPDATE telegram_summary_alerts SET attempts = 1, updated_at = now() - interval '2 minutes' WHERE id = 31"
      );
      assert.equal(
        await telegramAlertRepo.findNextRetryAt({ inactivityMinutes: 10 }),
        null
      );

      // If the primary actionable alert ultimately fails, the normal summary is
      // allowed through as a fallback rather than being lost.
      await client.query(
        "UPDATE telegram_immediate_alerts SET status = 'failed' WHERE id = 80"
      );
      const retryAt = await telegramAlertRepo.findNextRetryAt({
        inactivityMinutes: 10,
      });
      assert.ok(retryAt instanceof Date);
      assert.ok(retryAt.getTime() <= Date.now());

      const fallbackCandidates = await telegramAlertRepo.findReadySummaries({
        inactivityMinutes: 10,
        limit: 5,
      });
      assert.equal(fallbackCandidates.length, 1);
      assert.equal(fallbackCandidates[0].alert_id, 31);

      // A newer staff message resets conversation inactivity even though it does
      // not invalidate the summary snapshot like a newer customer message does.
      await client.query(
        "INSERT INTO messages (id, contact_id, role, created_at) VALUES (46, 12, 'assistant', now())"
      );
      const delayedRetryAt = await telegramAlertRepo.findNextRetryAt({
        inactivityMinutes: 10,
      });
      assert.ok(delayedRetryAt instanceof Date);
      assert.ok(delayedRetryAt.getTime() > Date.now() + 9 * 60 * 1000);
      await client.query("DELETE FROM messages WHERE id = 46");

      // Once the actionable alert is actually delivered, the redundant normal
      // summary is permanently superseded.
      await client.query(
        "UPDATE telegram_immediate_alerts SET status = 'sent' WHERE id = 80"
      );
      const superseded = await telegramAlertRepo.supersedeCoveredSummaries();
      assert.ok(superseded.some((row) => row.id === 31));
      const normalState = await client.query(
        "SELECT status FROM telegram_summary_alerts WHERE id = 31"
      );
      assert.equal(normalState.rows[0].status, "superseded");

      // Manual Review is operationally important and must remain eligible even
      // when an actionable sales alert was already sent.
      await client.query(`
        INSERT INTO telegram_summary_alerts (
          id, lead_id, through_message_id, score_data, created_at
        ) VALUES (
          32,
          7,
          44,
          '{"alertType":"ai_scoring_failed","summaryUnavailable":true,"summary":{}}'::jsonb,
          now()
        )
      `);
      const manualReviewCandidates = await telegramAlertRepo.findReadySummaries({
        inactivityMinutes: 10,
        limit: 5,
      });
      assert.equal(manualReviewCandidates.length, 1);
      assert.equal(manualReviewCandidates[0].alert_id, 32);

      const manualClaim = await telegramAlertRepo.claimSummary(32, 10);
      assert.equal(manualClaim.alert_id, 32);
      assert.equal(manualClaim.score_data.alertType, "ai_scoring_failed");
      await telegramAlertRepo.markSent(32);

      // A sent alert from an older lead for the same contact must not suppress a
      // later journey. Anti-spam ownership is lead-specific, not contact-only.
      await client.query(`
        INSERT INTO leads (
          id, contact_id, temperature, stage_id, appointment_status
        ) VALUES (8, 12, 'warm', 1, 'none');

        INSERT INTO messages (id, contact_id, role, created_at)
        VALUES (45, 12, 'user', now() - interval '20 minutes');

        INSERT INTO telegram_summary_alerts (
          id, lead_id, through_message_id, score_data, created_at
        ) VALUES (
          33,
          8,
          45,
          '{"temperature":"warm","summary":{"chatSummary":"New enquiry on a later lead."}}'::jsonb,
          now()
        );
      `);

      const laterLeadCandidates = await telegramAlertRepo.findReadySummaries({
        inactivityMinutes: 10,
        limit: 5,
      });
      assert.equal(laterLeadCandidates.length, 1);
      assert.equal(laterLeadCandidates[0].alert_id, 33);
      assert.equal(laterLeadCandidates[0].lead_id, 8);
    } finally {
      pool.query = originalQuery;
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
