const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");
const followUpRepo = require("../src/db/followUpRepo");
const followUpAiLeaseRepo = require("../src/db/followUpAiLeaseRepo");
const staffOwnershipService = require("../src/services/staffOwnershipService");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "a delayed earlier follow-up shifts the next step instead of sending both together",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString, ssl: false });
    const schemaName = `follow_up_spacing_${process.pid}_${Date.now()}`;
    const originalQuery = pool.query;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY,
          channel TEXT NOT NULL,
          whatsapp_number TEXT,
          channel_user_id TEXT,
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT,
          is_unread BOOLEAN NOT NULL DEFAULT false,
          mode TEXT NOT NULL DEFAULT 'ai',
          takeover_by TEXT,
          takeover_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE pipeline_stages (
          id INTEGER PRIMARY KEY,
          stage_type TEXT,
          system_key TEXT
        );

        CREATE TABLE leads (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          stage_id INTEGER REFERENCES pipeline_stages(id),
          treatment_interest TEXT,
          is_closed BOOLEAN NOT NULL DEFAULT false,
          appointment_status TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          whatsapp_message_id TEXT,
          sent_by_username TEXT,
          media_url TEXT,
          media_mime_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          delivery_status TEXT,
          delivery_error TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
          automated_follow_up_for_message_id INTEGER,
          automated_follow_up_step INTEGER,
          automated_follow_up_target_service TEXT,
          automated_follow_up_targeting_recorded BOOLEAN NOT NULL DEFAULT false,
          automated_follow_up_message_mode TEXT,
          UNIQUE (automated_follow_up_for_message_id, automated_follow_up_step)
        );

        CREATE TABLE follow_up_ai_decisions (
          id BIGSERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          trigger_message_id INTEGER,
          follow_up_step INTEGER NOT NULL,
          action TEXT NOT NULL,
          reason TEXT,
          topic TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (trigger_message_id, follow_up_step)
        );

        CREATE TABLE follow_up_ai_generation_claims (
          id BIGSERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          trigger_message_id INTEGER NOT NULL REFERENCES messages(id),
          follow_up_step INTEGER NOT NULL,
          lease_token TEXT NOT NULL,
          claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (trigger_message_id, follow_up_step)
        );

        INSERT INTO contacts (
          id, channel, whatsapp_number, needs_attention
        ) VALUES (
          1, 'whatsapp', '60123456789', false
        );

        INSERT INTO messages (
          id, contact_id, role, content, created_at, is_automated_follow_up
        ) VALUES
          (
            10, 1, 'user', 'I am interested',
            now() - interval '10 hours',
            false
          ),
          (
            11, 1, 'assistant', 'Sure, here are the details',
            now() - interval '9 hours',
            false
          );

        -- Step 1 was originally due 2 hours after the anchor, but quiet hours
        -- delayed the actual send until only one hour ago.
        INSERT INTO messages (
          id,
          contact_id,
          role,
          content,
          whatsapp_message_id,
          sent_by_username,
          created_at,
          delivery_status,
          is_automated_follow_up,
          automated_follow_up_for_message_id,
          automated_follow_up_step,
          automated_follow_up_targeting_recorded
        ) VALUES (
          12,
          1,
          'assistant',
          'First follow-up',
          'wamid.step1',
          'Follow-up automation',
          now() - interval '1 hour',
          'sent',
          true,
          11,
          1,
          true
        );
      `);

      pool.query = client.query.bind(client);

      const activatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const delays = [120, 480];

      const candidates = await followUpRepo.findCandidates({
        delayMinutes: delays,
        triggerMode: "all",
        activatedAt,
        limit: 25,
      });
      assert.deepEqual(candidates, []);

      const dueAt = await followUpRepo.getNextCandidateDueAt({
        delayMinutes: delays,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(dueAt);
      const dueInHours =
        (new Date(dueAt).getTime() - Date.now()) / (60 * 60 * 1000);
      assert.ok(
        dueInHours > 4.9 && dueInHours < 5.1,
        `expected Step 2 about 5 hours from now, got ${dueInHours}`
      );

      const prematureClaim = await followUpRepo.saveIfStillEligible({
        contactId: 1,
        triggerMessageId: 11,
        content: "Second follow-up",
        mediaUrl: "",
        stepIndex: 2,
        delayMinutes: 480,
        previousDelayMinutes: 120,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(prematureClaim, null);

      // Once the same 6-hour Step 1 -> Step 2 gap has elapsed, Step 2 can be
      // claimed normally.
      await client.query(
        "UPDATE messages SET created_at = now() - interval '7 hours' WHERE id = 12"
      );

      const dueCandidates = await followUpRepo.findCandidates({
        delayMinutes: delays,
        triggerMode: "all",
        activatedAt,
        limit: 25,
      });
      assert.equal(dueCandidates.length, 1);
      assert.equal(Number(dueCandidates[0].next_follow_up_step), 2);

      const claim = await followUpRepo.saveIfStillEligible({
        contactId: 1,
        triggerMessageId: 11,
        content: "Second follow-up",
        mediaUrl: "",
        stepIndex: 2,
        delayMinutes: 480,
        previousDelayMinutes: 120,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(claim);
      assert.equal(Number(claim.automated_follow_up_step), 2);

      await client.query(`
        INSERT INTO contacts (
          id, channel, whatsapp_number, needs_attention
        ) VALUES (
          2, 'whatsapp', '60112223344', false
        );

        INSERT INTO messages (
          id, contact_id, role, content, created_at, is_automated_follow_up
        ) VALUES
          (
            20, 2, 'user', 'I am interested',
            now() - interval '4 hours',
            false
          ),
          (
            21, 2, 'assistant', 'Here are the details',
            now() - interval '3 hours',
            false
          );
      `);

      const firstLease = await followUpAiLeaseRepo.claimIfStillEligible({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "lease-a",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(firstLease);

      const competingLease = await followUpAiLeaseRepo.claimIfStillEligible({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "lease-b",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(competingLease, null);

      const wrongRelease = await followUpAiLeaseRepo.release({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "wrong-token",
      });
      assert.equal(wrongRelease, null);

      const released = await followUpAiLeaseRepo.release({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "lease-a",
      });
      assert.ok(released);

      const secondLease = await followUpAiLeaseRepo.claimIfStillEligible({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "lease-c",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(secondLease);

      await client.query(
        "UPDATE follow_up_ai_generation_claims SET claimed_at = now() - interval '5 minutes' WHERE trigger_message_id = 21"
      );

      const recoveredLease = await followUpAiLeaseRepo.claimIfStillEligible({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "lease-d",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
        staleAfterSeconds: 30,
      });
      assert.ok(recoveredLease);
      assert.equal(recoveredLease.lease_token, "lease-d");

      await followUpAiLeaseRepo.release({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        leaseToken: "lease-d",
      });

      await client.query(`
        INSERT INTO contacts (
          id, channel, whatsapp_number, needs_attention, mode, takeover_by, takeover_at
        ) VALUES (
          3, 'whatsapp', '60119998877', true, 'human', 'AI handoff', now() - interval '5 minutes'
        );

        INSERT INTO messages (
          id, contact_id, role, content, created_at, is_automated_follow_up
        ) VALUES
          (
            30, 3, 'user', 'Can someone help me?',
            now() - interval '4 hours',
            false
          ),
          (
            31, 3, 'assistant', 'A staff member will help you shortly.',
            now() - interval '3 hours',
            false
          );
      `);

      const claimedHandoff = await staffOwnershipService.claimAiHandoffOwnership(
        3,
        "staff1"
      );
      assert.ok(claimedHandoff);
      assert.equal(claimedHandoff.takeover_by, "staff1");

      const cancellation = await client.query(
        `SELECT action, follow_up_step
         FROM follow_up_ai_decisions
         WHERE contact_id = 3 AND trigger_message_id = 31`
      );
      assert.equal(cancellation.rows.length, 1);
      assert.equal(cancellation.rows[0].action, "skip");
      assert.equal(Number(cancellation.rows[0].follow_up_step), 1);

      // Simulate the normal staff-send cleanup followed by Return to AI. The
      // durable decision must keep the old AI anchor dead even after the
      // temporary handoff/attention state has been cleared.
      await client.query(
        `UPDATE contacts
         SET needs_attention = false,
             attention_reason = NULL,
             mode = 'ai',
             takeover_by = NULL,
             takeover_at = NULL
         WHERE id = 3`
      );

      const cancelledLease = await followUpAiLeaseRepo.claimIfStillEligible({
        contactId: 3,
        triggerMessageId: 31,
        stepIndex: 1,
        leaseToken: "cancelled-handoff-lease",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(cancelledLease, null);

      const cancelledClaim = await followUpRepo.saveIfStillEligible({
        contactId: 3,
        triggerMessageId: 31,
        content: "This must not send",
        mediaUrl: "",
        stepIndex: 1,
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(cancelledClaim, null);

      await client.query(`
        INSERT INTO contacts (
          id, channel, whatsapp_number, needs_attention, mode, takeover_by, takeover_at
        ) VALUES (
          4, 'whatsapp', '60118887766', false, 'ai', NULL, NULL
        );

        INSERT INTO messages (
          id, contact_id, role, content, sent_by_username, created_at, is_automated_follow_up
        ) VALUES
          (
            40, 4, 'user', 'I will think about it',
            NULL,
            now() - interval '4 hours',
            false
          ),
          (
            41, 4, 'assistant', 'Sure, take your time.',
            'staff1',
            now() - interval '3 hours',
            false
          );
      `);

      const retakeover = await contactsRepo.takeOver(4, "staff2");
      assert.ok(retakeover);
      assert.equal(retakeover.mode, "human");
      assert.equal(retakeover.takeover_by, "staff2");

      const staffAnchorCancellation = await client.query(
        `SELECT action, follow_up_step
         FROM follow_up_ai_decisions
         WHERE contact_id = 4 AND trigger_message_id = 41`
      );
      assert.equal(staffAnchorCancellation.rows.length, 1);
      assert.equal(staffAnchorCancellation.rows[0].action, "skip");
      assert.equal(Number(staffAnchorCancellation.rows[0].follow_up_step), 1);

      // Re-takeover is a new human intervention boundary. Returning to AI must
      // not revive the pre-takeover staff-originated sequence.
      await contactsRepo.returnToAi(4);

      const oldStaffLease = await followUpAiLeaseRepo.claimIfStillEligible({
        contactId: 4,
        triggerMessageId: 41,
        stepIndex: 1,
        leaseToken: "cancelled-staff-anchor-lease",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(oldStaffLease, null);

      const oldStaffClaim = await followUpRepo.saveIfStillEligible({
        contactId: 4,
        triggerMessageId: 41,
        content: "Old staff sequence must stay cancelled",
        mediaUrl: "",
        stepIndex: 1,
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.equal(oldStaffClaim, null);

      const reviewDecision = await followUpRepo.recordAiDecisionIfStillEligible({
        contactId: 2,
        triggerMessageId: 21,
        stepIndex: 1,
        action: "human_review",
        reason: "Customer asked a medical suitability question.",
        topic: "3D 小颜术",
        delayMinutes: 120,
        previousDelayMinutes: 0,
        triggerMode: "all",
        activatedAt,
      });
      assert.ok(reviewDecision);

      const flagged = await client.query(
        "SELECT needs_attention, attention_reason FROM contacts WHERE id = 2"
      );
      assert.equal(flagged.rows[0].needs_attention, true);
      assert.match(
        flagged.rows[0].attention_reason,
        /AI follow-up requested human review: Customer asked a medical suitability question\./
      );

    } finally {
      pool.query = originalQuery;
      await client.query("SET search_path TO public").catch(() => {});
      await client
        .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
        .catch(() => {});
      await client.end();
    }
  }
);
