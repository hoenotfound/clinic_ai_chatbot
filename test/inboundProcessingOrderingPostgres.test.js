const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");

const connectionString = process.env.TEST_DATABASE_URL;

function inbound(id, from, text) {
  return {
    id,
    from,
    channel: "whatsapp",
    text,
    mediaType: null,
    unsupportedType: null,
  };
}

test(
  "lease ownership preserves live bursts but blocks post-restart overtaking",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `inbound_ordering_${process.pid}_${Date.now()}`;
    const processingSql = fs.readFileSync(
      path.join(__dirname, "../src/db/inboundProcessingSchema.sql"),
      "utf8"
    );

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (
          id SERIAL PRIMARY KEY
        );
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          whatsapp_message_id TEXT UNIQUE,
          sent_by_username TEXT,
          media_url TEXT,
          media_key TEXT,
          media_mime_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivery_status TEXT,
          delivery_error TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false
        );
      `);
      await client.query(processingSql);

      // Normal live traffic: two rapid bubbles are leased by the same process
      // and must still be allowed into the existing 1.2s typing burst.
      const liveContact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const liveContactId = liveContact.rows[0].id;
      const liveOne = inbound("wamid-live-1", "60111111111", "hi");
      const liveTwo = inbound("wamid-live-2", "60111111111", "how much hifu");
      const liveClaimOne = await inboundProcessingRepo.storeInboundClaim({
        contactId: liveContactId,
        content: liveOne.text,
        storedMessageId: liveOne.id,
        channel: "whatsapp",
        incoming: liveOne,
      }, client);
      const liveClaimTwo = await inboundProcessingRepo.storeInboundClaim({
        contactId: liveContactId,
        content: liveTwo.text,
        storedMessageId: liveTwo.id,
        channel: "whatsapp",
        incoming: liveTwo,
      }, client);

      const liveLeaseOne = await inboundProcessingRepo.claimPendingByMessageId(
        liveClaimOne.savedInbound.id,
        client,
        "live-process-a"
      );
      const liveLeaseTwo = await inboundProcessingRepo.claimPendingByMessageId(
        liveClaimTwo.savedInbound.id,
        client,
        "live-process-a"
      );
      assert.equal(liveLeaseOne.lease_owner, "live-process-a");
      assert.equal(liveLeaseTwo.lease_owner, "live-process-a");
      await inboundProcessingRepo.markCompleted(liveLeaseOne.id, client);
      await inboundProcessingRepo.markCompleted(liveLeaseTwo.id, client);

      // Restart/deploy case: the old message is still leased by a different
      // process. The new message must remain pending rather than overtaking it.
      const restartContact = await client.query(
        "INSERT INTO contacts DEFAULT VALUES RETURNING id"
      );
      const restartContactId = restartContact.rows[0].id;
      const oldMessage = inbound("wamid-old-before-restart", "60122222222", "How much HIFU?");
      const newMessage = inbound("wamid-new-after-restart", "60122222222", "For double chin");
      const oldClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId: restartContactId,
        content: oldMessage.text,
        storedMessageId: oldMessage.id,
        channel: "whatsapp",
        incoming: oldMessage,
      }, client);
      const newClaim = await inboundProcessingRepo.storeInboundClaim({
        contactId: restartContactId,
        content: newMessage.text,
        storedMessageId: newMessage.id,
        channel: "whatsapp",
        incoming: newMessage,
      }, client);

      const oldLease = await inboundProcessingRepo.claimPendingByMessageId(
        oldClaim.savedInbound.id,
        client,
        "old-render-process"
      );
      assert.equal(oldLease.status, "processing");

      const blockedNewLease = await inboundProcessingRepo.claimPendingByMessageId(
        newClaim.savedInbound.id,
        client,
        "new-render-process"
      );
      assert.equal(blockedNewLease, null);

      const tooEarlyRecovery = await inboundProcessingRepo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 180,
        maxAttempts: 5,
        ownerId: "new-render-process",
      }, client);
      assert.deepEqual(tooEarlyRecovery, []);

      // Once the predecessor lease is stale, recovery claims both the old job
      // and its pending follower in one sweep so the existing grouped replay can
      // produce one coherent AI turn in message-id order.
      await client.query(
        `UPDATE inbound_processing_jobs
         SET claimed_at = NOW() - interval '4 minutes'
         WHERE id = $1`,
        [oldLease.id]
      );
      const recovered = await inboundProcessingRepo.claimRecoverable({
        limit: 10,
        staleAfterSeconds: 180,
        maxAttempts: 5,
        ownerId: "new-render-process",
      }, client);
      recovered.sort((a, b) => Number(a.message_id) - Number(b.message_id));
      assert.deepEqual(
        recovered.map((job) => job.message_id),
        [oldClaim.savedInbound.id, newClaim.savedInbound.id]
      );
      assert.deepEqual(
        recovered.map((job) => job.lease_owner),
        ["new-render-process", "new-render-process"]
      );
      assert.deepEqual(
        recovered.map((job) => job.attempts),
        [2, 1]
      );
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);

test(
  "Meta message_edit resolution jobs are durable, deduplicated and retryable",
  { skip: !connectionString },
  async () => {
    const client = new Client({ connectionString });
    const schemaName = `meta_resolution_${process.pid}_${Date.now()}`;
    const processingSql = fs.readFileSync(
      path.join(__dirname, "../src/db/inboundProcessingSchema.sql"),
      "utf8"
    );

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`SET search_path TO ${schemaName}`);
      await client.query(`
        CREATE TABLE contacts (id SERIAL PRIMARY KEY);
        CREATE TABLE messages (
          id SERIAL PRIMARY KEY,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          whatsapp_message_id TEXT UNIQUE,
          sent_by_username TEXT,
          media_url TEXT,
          media_key TEXT,
          media_mime_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          delivery_status TEXT,
          delivery_error TEXT,
          is_automated_follow_up BOOLEAN NOT NULL DEFAULT false
        );
      `);
      await client.query(processingSql);

      const placeholder = {
        id: "meta-edit:ig-mid-9",
        from: "meta-edit:ig-mid-9",
        channel: "instagram",
        metaResolutionOnly: true,
        metaMessageId: "ig-mid-9",
        metaEntryId: "ig-business-9",
      };
      const first = await inboundProcessingRepo.storeMetaResolutionClaim({
        channel: "instagram",
        externalMessageId: "ig-mid-9",
        entryId: "ig-business-9",
        incoming: placeholder,
      }, client);
      assert.ok(first?.id);
      assert.equal(first.status, "pending");

      const duplicate = await inboundProcessingRepo.storeMetaResolutionClaim({
        channel: "instagram",
        externalMessageId: "ig-mid-9",
        entryId: "ig-business-9",
        incoming: placeholder,
      }, client);
      assert.equal(duplicate, null);

      const claimed = await inboundProcessingRepo.claimMetaResolutionByExternalId({
        channel: "instagram",
        externalMessageId: "ig-mid-9",
        ownerId: "resolver-a",
      }, client);
      assert.equal(claimed.status, "processing");
      assert.equal(claimed.attempts, 1);
      assert.equal(claimed.lease_owner, "resolver-a");

      const failed = await inboundProcessingRepo.markMetaResolutionFailed(
        claimed.id,
        new Error("temporary Graph failure"),
        client
      );
      assert.equal(failed.status, "failed");
      assert.equal(failed.lease_owner, null);

      const retried = await inboundProcessingRepo.claimRecoverableMetaResolutions({
        limit: 10,
        staleAfterSeconds: 180,
        maxAttempts: 5,
        ownerId: "resolver-b",
      }, client);
      assert.equal(retried.length, 1);
      assert.equal(retried[0].id, claimed.id);
      assert.equal(retried[0].attempts, 2);
      assert.equal(retried[0].lease_owner, "resolver-b");

      await inboundProcessingRepo.markMetaResolutionCompleted(claimed.id, client);
      const none = await inboundProcessingRepo.claimRecoverableMetaResolutions({
        limit: 10,
        staleAfterSeconds: 180,
        maxAttempts: 5,
      }, client);
      assert.deepEqual(none, []);
    } finally {
      await client.query("SET search_path TO public").catch(() => {});
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await client.end();
    }
  }
);
