const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const repo = require("../src/db/metaCommentAutomationRepo");

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "comment private reply echo is checkpointed from a durable pre-send reservation",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName =
      `comment_echo_guard_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);

      for (const migration of [
        "017_meta_comment_automation.sql",
        "019_meta_comment_private_reply_echo_guard.sql",
      ]) {
        const sql = fs.readFileSync(
          path.join(__dirname, "..", "src", "db", "migrations", migration),
          "utf8"
        );
        await client.query(sql);
      }

      const stored = await repo.storeIncomingComment(
        {
          channel: "instagram",
          commentId: "comment-1",
          entryId: "ig-business",
          authorId: "igsid-1",
          authorName: "Alicia",
          text: "How much?",
          postId: null,
          mediaId: "media-1",
          parentCommentId: null,
          createdAt: new Date().toISOString(),
          rawEvent: {},
        },
        client
      );
      const claimed = await repo.claimJob(stored.id, client);
      assert.equal(claimed.status, "processing");

      const pending = await repo.markPrivateReplyPending(
        stored.id,
        { text: "Hi! Which area are you asking about?" },
        client
      );
      assert.equal(
        pending.privateReplyPendingText,
        "Hi! Which area are you asking about?"
      );
      assert.ok(pending.privateReplyPendingAt);

      const failedAfterAccept = await repo.markFailedPreservingPrivateReplyPending(
        stored.id,
        new Error("simulated DB checkpoint failure after Meta accepted the DM"),
        1,
        client
      );
      assert.equal(failedAfterAccept.status, "failed");
      assert.equal(
        failedAfterAccept.privateReplyPendingText,
        "Hi! Which area are you asking about?"
      );
      assert.ok(failedAfterAccept.privateReplyPendingAt);

      const wrongText = await repo.recordPendingPrivateReplyEcho(
        {
          channel: "instagram",
          recipientId: "igsid-1",
          text: "Different message",
          messageId: "ig-wrong-mid",
        },
        client
      );
      assert.equal(wrongText, null);

      const matched = await repo.recordPendingPrivateReplyEcho(
        {
          channel: "instagram",
          recipientId: "igsid-1",
          text: "Hi! Which area are you asking about?",
          messageId: "ig-private-mid",
        },
        client
      );
      assert.equal(matched.privateReplyMessageId, "ig-private-mid");
      assert.equal(matched.privateReplyRecipientId, "igsid-1");
      assert.equal(matched.privateReplyPendingText, null);
      assert.equal(matched.privateReplyPendingAt, null);

      // The API response can arrive after the webhook. COALESCE must preserve
      // the real MID already captured from the echo instead of overwriting it.
      const finalized = await repo.markPrivateReplySent(
        stored.id,
        {
          messageId: "api-response-mid",
          recipientId: "igsid-1",
        },
        client
      );
      assert.equal(finalized.privateReplyMessageId, "ig-private-mid");
      assert.equal(finalized.privateReplyRecipientId, "igsid-1");
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client
        .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
        .catch(() => {});
      await client.end();
    }
  }
);