const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const repo = require("../src/db/whatsappDeliveryStatusRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "WhatsApp delivery-status jobs dedupe, fence stale leases and persist terminal state",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `wa_delivery_status_${process.pid}_${Date.now()}`;
    const migrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/014_whatsapp_delivery_status_jobs.sql"),
      "utf8"
    );
    const integrityMigrationSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/045_whatsapp_unmatched_delivery_monitoring.sql"),
      "utf8"
    );
    const provenanceSql = fs.readFileSync(
      path.join(__dirname, "../src/db/migrations/082_whatsapp_delivery_sender_provenance.sql"),
      "utf8"
    );
    const query = client.query.bind(client);

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY,
          needs_attention BOOLEAN NOT NULL DEFAULT false,
          attention_reason TEXT,
          delivery_attention_dismissed_at TIMESTAMPTZ,
        delivery_attention_message_id integer,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL,
          role TEXT DEFAULT 'assistant',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          whatsapp_message_id TEXT UNIQUE,
          delivery_status TEXT,
          delivery_error TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
          whatsapp_template JSONB,
          pricing_reminder_anchor_id INTEGER,
          automated_follow_up_for_message_id INTEGER,
          automated_follow_up_parent_message_id INTEGER,
          media_key TEXT,media_url TEXT,media_base64 TEXT,media_mime_type TEXT
        );
        CREATE TABLE scheduled_messages(message_id INTEGER);
        CREATE TABLE outbound_message_evidence (
          message_id INTEGER,
          provider_message_id TEXT
        );
      `);
      await client.query(migrationSql);
      await client.query(integrityMigrationSql);
      await client.query(provenanceSql);

      const update = {
        wamid: "wamid-durable-status-1",
        status: "delivered",
        errorCode: null,
        errorTitle: null,
        errorMessage: null,
      };
      const first = await repo.storeBatch([update], query);
      assert.equal(first.length, 1);
      assert.equal(first[0].processing_status, "pending");
      assert.equal(first[0].attempts, 0);
      assert.equal(first[0].lease_token, null);

      const tagged = await repo.storeBatch([{
        wamid: "wamid-tagged-sender", status: "sent",
        businessPhoneNumberId: "1408739622311791",
        businessAccountId: "200000000000001",
      }], query);
      assert.equal(tagged.length,1);
      const storedIdentity = (await client.query(
        "SELECT business_phone_number_id,business_account_id FROM whatsapp_delivery_status_jobs WHERE id=$1",
        [tagged[0].id]
      )).rows[0];
      assert.deepEqual(storedIdentity,{
        business_phone_number_id:"1408739622311791",
        business_account_id:"200000000000001"
      });
      const duplicate = await repo.storeBatch([update], query);
      assert.deepEqual(duplicate, []);
      const count = await client.query(
        "SELECT COUNT(*)::int AS count FROM whatsapp_delivery_status_jobs"
      );
      assert.equal(count.rows[0].count, 2);

      const claimed = await repo.claimByIds([first[0].id], query);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].processing_status, "processing");
      assert.equal(claimed[0].attempts, 1);
      assert.match(claimed[0].lease_token, /^[a-f0-9]{32}$/);

      await repo.markFailed(
        claimed[0].id,
        claimed[0].lease_token,
        new Error("temporary database failure"),
        query
      );
      const retry = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(retry.length, 1);
      assert.equal(retry[0].id, claimed[0].id);
      assert.equal(retry[0].attempts, 2);
      assert.match(retry[0].lease_token, /^[a-f0-9]{32}$/);
      assert.notEqual(retry[0].lease_token, claimed[0].lease_token);

      await repo.markCompleted(retry[0].id, retry[0].lease_token, query);
      const none = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.deepEqual(none, []);

      // A stale worker that wakes up after another process completed this job
      // must not be able to roll the terminal state backward.
      assert.equal(
        await repo.markFailed(
          retry[0].id,
          claimed[0].lease_token,
          new Error("late stale-worker failure"),
          query
        ),
        null
      );
      assert.equal(await repo.markTerminal(retry[0].id, query), null);
      const completedRow = await client.query(
        "SELECT processing_status, lease_token, terminal_at FROM whatsapp_delivery_status_jobs WHERE id = $1",
        [retry[0].id]
      );
      assert.deepEqual(completedRow.rows[0], {
        processing_status: "completed",
        lease_token: null,
        terminal_at: null,
      });

      const staleStored = await repo.storeBatch([
        { wamid: "wamid-durable-status-stale", status: "read" },
      ], query);
      const staleClaim = await repo.claimByIds([staleStored[0].id], query);
      await client.query(
        `UPDATE whatsapp_delivery_status_jobs
         SET claimed_at = NOW() - interval '2 minutes'
         WHERE id = $1`,
        [staleClaim[0].id]
      );
      const staleRecovered = await repo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(staleRecovered.length, 1);
      assert.equal(staleRecovered[0].id, staleClaim[0].id);
      assert.equal(staleRecovered[0].attempts, 2);
      assert.notEqual(staleRecovered[0].lease_token, staleClaim[0].lease_token);

      // The replaced worker is still alive in this simulation. Its old lease
      // must not be able to fail or complete the newer worker's active claim.
      assert.equal(
        await repo.markFailed(
          staleClaim[0].id,
          staleClaim[0].lease_token,
          new Error("old worker resumed late"),
          query
        ),
        null
      );
      assert.equal(
        await repo.markCompleted(
          staleClaim[0].id,
          staleClaim[0].lease_token,
          query
        ),
        null
      );
      const replacementLease = await client.query(
        `SELECT processing_status, attempts, lease_token
         FROM whatsapp_delivery_status_jobs
         WHERE id = $1`,
        [staleClaim[0].id]
      );
      assert.deepEqual(replacementLease.rows[0], {
        processing_status: "processing",
        attempts: 2,
        lease_token: staleRecovered[0].lease_token,
      });

      await client.query(
        `UPDATE whatsapp_delivery_status_jobs
         SET attempts = 5,
             processing_status = 'processing',
             claimed_at = NOW() - interval '2 minutes',
             last_error = 'simulated final-attempt crash'
         WHERE id = $1`,
        [staleClaim[0].id]
      );
      const exhausted = await repo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.equal(exhausted.length, 1);
      assert.equal(exhausted[0].id, staleClaim[0].id);

      const terminal = await repo.markTerminal(staleClaim[0].id, query);
      assert.ok(terminal.terminal_at);
      assert.equal(terminal.lease_token, null);
      const noLongerExhausted = await repo.listExhausted({
        limit: 10,
        staleAfterSeconds: 45,
        maxAttempts: 5,
      }, query);
      assert.deepEqual(noLongerExhausted, []);
      assert.equal(
        await repo.markCompleted(
          staleClaim[0].id,
          staleRecovered[0].lease_token,
          query
        ),
        null
      );

      await client.query(
        `INSERT INTO contacts (id) VALUES (42);
         INSERT INTO messages (contact_id, whatsapp_message_id, delivery_status, delivery_error)
         VALUES (42, 'wamid-find-me', 'failed', 'provider failure')`
      );
      const message = await repo.findMessageByWamid("wamid-find-me", query);
      assert.equal(message.contact_id, 42);
      assert.equal(message.delivery_status, "failed");

      const attention = await repo.setDeliveryAttentionState(
        42,
        "Delivery failed: provider failure",
        query
      );
      assert.equal(attention.id, 42);
      const attentionRow = await client.query(
        "SELECT needs_attention, attention_reason FROM contacts WHERE id = 42"
      );
      assert.deepEqual(attentionRow.rows[0], {
        needs_attention: true,
        attention_reason: "Delivery failed: provider failure",
      });

      // Exact replays should be no-ops so they do not keep bumping contact
      // timestamps or emitting unnecessary realtime refreshes.
      assert.equal(
        await repo.setDeliveryAttentionState(
          42,
          "Delivery failed: provider failure",
          query
        ),
        null
      );

      // A durable delivery replay must never replace a more important handoff
      // or safety reason that staff is already looking at.
      await client.query(
        `UPDATE contacts
         SET needs_attention = true, attention_reason = 'AI handoff: urgent review'
         WHERE id = 42`
      );
      const protectedAttention = await repo.setDeliveryAttentionState(
        42,
        "Delivery failed: later replay",
        query
      );
      assert.equal(protectedAttention, null);
      const protectedRow = await client.query(
        "SELECT needs_attention, attention_reason FROM contacts WHERE id = 42"
      );
      assert.deepEqual(protectedRow.rows[0], {
        needs_attention: true,
        attention_reason: "AI handoff: urgent review",
      });

      // Late provider failures must not reopen a resolved text conversation.
      // The callback can be processed many minutes after a separate staff
      // reply, so base the decision on the actual failed message timestamp.
      await client.query(`
        INSERT INTO contacts(id) VALUES(43),(44),(45);
        INSERT INTO messages(id,contact_id,created_at,delivery_status)
          VALUES (1001,43,now()-interval '10 minutes','failed');
        INSERT INTO messages(id,contact_id,created_at,delivery_status,
                             whatsapp_message_id)
          VALUES (1002,43,now()-interval '5 minutes','read','wamid.new1002');
      `);
      assert.equal(await repo.setDeliveryAttentionState(
        43,'Delivery failed: obsolete text',query,1001),null);
      assert.equal((await client.query(
        'SELECT needs_attention FROM contacts WHERE id=43'
      )).rows[0].needs_attention,false);

      // A failed photo must stay actionable even after a later text reply.
      await client.query(`
        INSERT INTO messages(id,contact_id,created_at,delivery_status,
                             media_key,media_mime_type)
        VALUES (1003,44,now()-interval '10 minutes','failed','photo-1','image/png');
        INSERT INTO messages(id,contact_id,created_at,delivery_status,
                             whatsapp_message_id)
        VALUES (1004,44,now()-interval '5 minutes','read','wamid.new1004');
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        44,'Delivery failed: image',query,1003)).id,44);

      // No newer accepted direct reply: the text failure must be visible.
      await client.query(`
        INSERT INTO messages(id,contact_id,created_at,delivery_status)
        VALUES (1005,45,now()-interval '10 minutes','failed');
        INSERT INTO messages(id,contact_id,created_at,delivery_status,
                             whatsapp_message_id,whatsapp_template)
        VALUES (1006,45,now()-interval '5 minutes','read',
                'wamid.marketing1006','{"name":"marketing"}'::jsonb);
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        45,'Delivery failed: unanswered text',query,1005)).id,45);
      await client.query("UPDATE messages SET delivery_status='read' WHERE id=1005");
      assert.equal(await repo.setDeliveryAttentionState(
        45,'Delivery failed: already retried',query,1005),null);

      // Dismissed old failure callbacks must not reopen a Telegram/Inbox
      // warning, even if the provider delivers them after staff dismissal.
      await client.query(`
        INSERT INTO contacts(id,delivery_attention_dismissed_at) VALUES (46,now());
        INSERT INTO messages(id,contact_id,created_at,delivery_status,media_key,media_mime_type)
        VALUES (1007,46,now()-interval '2 hours','failed','old-photo','image/jpeg');
      `);
      assert.equal(await repo.setDeliveryAttentionState(
        46,'Delivery failed: old photo callback',query,1007),null);
      assert.equal((await client.query(
        'SELECT needs_attention FROM contacts WHERE id=46'
      )).rows[0].needs_attention,false);

      // A fresh provider failure after that acknowledgement is still urgent.
      await client.query(`
        INSERT INTO messages(id,contact_id,created_at,delivery_status,media_key,media_mime_type)
        VALUES (1008,46,clock_timestamp()+interval '1 second',
          'failed','new-photo','image/jpeg');
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        46,'Delivery failed: new photo callback',query,1008)).id,46);

      // A late media callback from a PREVIOUS customer turn is a historical
      // failed attempt, not a new attention task. Contact #433 had this shape:
      // failed image, newer inbound, and a later real staff reply.
      await client.query(`
        INSERT INTO contacts(id) VALUES (47),(48),(49);
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES (1009,47,'assistant',now()-interval '1 hour','failed',
                'https://example.invalid/old-photo.jpg');
        INSERT INTO messages(id,contact_id,role,created_at)
        VALUES (1010,47,'user',now()-interval '30 minutes');
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                             whatsapp_message_id)
        VALUES (1011,47,'assistant',now()-interval '15 minutes','read',
                'wamid.staff-old47');
      `);
      assert.equal(await repo.setDeliveryAttentionState(
        47,'Delivery failed: obsolete historical image',query,1009),null,
        "a replayed failure from an older episode cannot reopen new attention");
      assert.equal((await client.query(
        'SELECT needs_attention FROM contacts WHERE id=47'
      )).rows[0].needs_attention,false);
      assert.equal((await client.query(
        'SELECT delivery_status FROM messages WHERE id=1009'
      )).rows[0].delivery_status,'failed',
        "old media failure audit remains unchanged");

      // A deliberately still-open delivery warning is NOT dismissed by a
      // newer customer message. Its callback remains eligible for recovery.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES (1012,48,'assistant',now()-interval '1 hour','failed',
                'https://example.invalid/unresolved.jpg');
        INSERT INTO messages(id,contact_id,role,created_at)
        VALUES (1013,48,'user',now()-interval '30 minutes');
        UPDATE contacts SET needs_attention=true,
          attention_reason='Delivery failed: explicitly under staff review'
        WHERE id=48;
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        48,'Delivery failed: old media under review',query,1012)).id,48);

      // If the attachment failed in the CURRENT episode, it must be
      // surfaced regardless of a later successfully accepted staff text.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,created_at)
        VALUES (1014,49,'user',now()-interval '1 hour');
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES (1015,49,'assistant',now()-interval '55 minutes','failed',
                'https://example.invalid/new-photo.jpg');
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,
                             whatsapp_message_id)
        VALUES (1016,49,'assistant',now()-interval '50 minutes','read',
                'wamid.staff-new49');
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        49,'Delivery failed: current episode photo',query,1015)).id,49);

      // A newer failed photo now owns the delivery attention, while an old
      // failed image belongs to a previous customer turn. Webhooks can
      // arrive out of order: the older callback must neither relink the
      // visible warning nor overwrite its more recent reason.
      await client.query(`
        INSERT INTO contacts(id) VALUES(50);
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES(1020,50,'assistant',now()-interval '2 hours','failed',
               'https://example.invalid/old.jpg');
        INSERT INTO messages(id,contact_id,role,created_at)
        VALUES(1021,50,'user',now()-interval '1 hour');
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES(1022,50,'assistant',now()-interval '10 minutes','failed',
               'https://example.invalid/new.jpg');
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        50,'Delivery failed: current photo',query,1022)).id,50);
      let anchored = (await client.query(
        'SELECT delivery_attention_message_id,attention_reason FROM contacts WHERE id=50'
      )).rows[0];
      assert.equal(anchored.delivery_attention_message_id,1022);
      assert.equal(anchored.attention_reason,'Delivery failed: current photo');
      assert.equal(await repo.setDeliveryAttentionState(
        50,'Delivery failed: stale old photo callback',query,1020),null);
      anchored=(await client.query(
        'SELECT delivery_attention_message_id,attention_reason FROM contacts WHERE id=50'
      )).rows[0];
      assert.equal(anchored.delivery_attention_message_id,1022,
        "older out-of-order callback must not steal the active warning");
      assert.equal(anchored.attention_reason,'Delivery failed: current photo');
      // Independent of episode retirement, the latest callback must win
      // even when both failed attempts belong to the same customer turn.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES(1023,50,'assistant',now()-interval '5 minutes','failed',
               'https://example.invalid/newer.jpg');
      `);
      assert.equal((await repo.setDeliveryAttentionState(
        50,'Delivery failed: newer photo',query,1023)).id,50);
      assert.equal(await repo.setDeliveryAttentionState(
        50,'Delivery failed: older current-episode photo',query,1022),null);
      anchored=(await client.query(
        'SELECT delivery_attention_message_id,attention_reason FROM contacts WHERE id=50'
      )).rows[0];
      assert.equal(anchored.delivery_attention_message_id,1023);
      assert.equal(anchored.attention_reason,'Delivery failed: newer photo');

      // Two different failed messages can have the IDENTICAL Meta error
      // text. The second is a new task even when the reason string matches.
      // A replay of the same message+reason, or an older callback after the
      // newer warning is active, must still be a no-op.
      await client.query(`
        INSERT INTO contacts(id) VALUES (51);
        INSERT INTO messages(id,contact_id,role,created_at,delivery_status,media_url)
        VALUES
          (1030,51,'assistant',now()-interval '20 minutes','failed',
           'https://example.invalid/same-error-a.jpg'),
          (1031,51,'assistant',now()-interval '10 minutes','failed',
           'https://example.invalid/same-error-b.jpg');
      `);
      const identicalReason = 'Delivery failed: WhatsApp reported delivery as failed.';
      assert.equal((await repo.setDeliveryAttentionState(
        51,identicalReason,query,1030)).id,51);
      assert.equal((await repo.setDeliveryAttentionState(
        51,identicalReason,query,1031)).id,51,
        "the same error text on a newer message must update the task anchor");
      let sameErrorTask = (await client.query(
        "SELECT needs_attention,attention_reason,delivery_attention_message_id FROM contacts WHERE id=51"
      )).rows[0];
      assert.equal(sameErrorTask.needs_attention,true);
      assert.equal(sameErrorTask.attention_reason,identicalReason);
      assert.equal(sameErrorTask.delivery_attention_message_id,1031);
      assert.equal(await repo.setDeliveryAttentionState(
        51,identicalReason,query,1031),null,
        "the exact same message+reason callback is idempotent");
      assert.equal(await repo.setDeliveryAttentionState(
        51,identicalReason,query,1030),null,
        "a late older callback cannot steal the anchor when reasons match");
      sameErrorTask = (await client.query(
        "SELECT attention_reason,delivery_attention_message_id FROM contacts WHERE id=51"
      )).rows[0];
      assert.equal(sameErrorTask.delivery_attention_message_id,1031);
      assert.equal(sameErrorTask.attention_reason,identicalReason);

      // A completed provider failure can lose its matching message later.
      // Flag it once after a grace period, but exclude known message/evidence
      // records and preserve the flagged row through ordinary pruning.
      const failureCases = await repo.storeBatch([
        { wamid: "wamid-orphaned", status: "failed", errorCode: "131053" },
        { wamid: "wamid-linked", status: "failed", errorCode: "131053" },
        { wamid: "wamid-evidence", status: "failed", errorCode: "131053" },
        { wamid: "wamid-recent", status: "failed", errorCode: "131053" }
      ], query);
      for (const item of failureCases) {
        const rows = await repo.claimByIds([item.id], query);
        await repo.markCompleted(item.id, rows[0].lease_token, query);
      }
      await client.query(
        `UPDATE whatsapp_delivery_status_jobs
         SET completed_at = NOW() - interval '10 minutes'
         WHERE wamid IN ('wamid-orphaned','wamid-linked','wamid-evidence')`
      );
      await client.query(
        "INSERT INTO messages (contact_id, whatsapp_message_id) VALUES (42, 'wamid-linked')"
      );
      await client.query(
        "INSERT INTO outbound_message_evidence (provider_message_id) VALUES ('wamid-evidence')"
      );
      const flagged = await repo.flagUnmatchedCompletedFailures(
        { graceSeconds: 300, limit: 25 }, query
      );
      assert.deepEqual(flagged.map((row) => row.id), [failureCases[0].id]);
      assert.deepEqual(await repo.flagUnmatchedCompletedFailures(
        { graceSeconds: 300, limit: 25 }, query
      ), []);
      const persisted = await client.query(
        "SELECT unmatched_detected_at FROM whatsapp_delivery_status_jobs WHERE id = $1",
        [failureCases[0].id]
      );
      assert.ok(persisted.rows[0].unmatched_detected_at);
      await repo.pruneCompleted({ olderThanHours: 0 }, query);
      const retained = await client.query(
        "SELECT id FROM whatsapp_delivery_status_jobs WHERE id = $1",
        [failureCases[0].id]
      );
      assert.equal(retained.rowCount, 1);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);

test("unsupported provider statuses are ignored instead of poisoning webhook persistence", () => {
  assert.equal(repo.normalizeUpdate({ wamid: "x", status: "unknown_future_status" }), null);
  assert.equal(repo.normalizeUpdate({ status: "read" }), null);
});
