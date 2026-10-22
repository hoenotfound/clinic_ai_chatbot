"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");
const repo = require("../src/db/whatsappSenderConversationRepo");

test("migration 079 keeps two sender conversations separate without rewriting historical contacts",
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    const db = new Client({ connectionString });
    const schema = "phase2_" + process.pid + "_" + Date.now();
    await db.connect();
    try {
      await db.query("CREATE SCHEMA " + schema);
      await db.query("SET search_path TO " + schema);
      const scoped = {
        async connect() {
          const client = new Client({ connectionString });
          await client.connect();
          await client.query("SET search_path TO " + schema);
          return { query: (...args) => client.query(...args), release: () => client.end() };
        },
      };
      assert.equal(loadMigrations().at(-1).version, 79);
      await runMigrations(scoped, { quiet: true });
      await db.query(
        "INSERT INTO whatsapp_sender_accounts (sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
        "VALUES ('neutro','100000000000001','200000000000001','Neutro','testing')," +
        "('ariel','100000000000002','200000000000002','Ariel','testing')"
      );
      const oldContact = (await db.query(
        "INSERT INTO contacts (whatsapp_number) VALUES ('60123001234') RETURNING id"
      )).rows[0].id;
      await db.query(
        "INSERT INTO messages (contact_id,role,content) VALUES ($1,'user','historical')",
        [oldContact]
      );
      const input = customerPhone => ({ accountId: "200000000000001",
        phoneNumberId: "100000000000001", customerPhone });
      const first = await repo.reservePendingConversation(input("60123001234"), db);
      const second = await repo.reservePendingConversation({
        accountId: "200000000000002", phoneNumberId: "100000000000002",
        customerPhone: "+60 12-300 1234",
      }, db);
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.id, second.id);
      assert.equal(first.contact_id, null);
      assert.equal(second.contact_id, null);
      const repeat = await repo.reservePendingConversation(input("0123001234"), db);
      assert.equal(repeat.id, first.id);
      const mismatch = await repo.reservePendingConversation({
        accountId: "200000000000001", phoneNumberId: "100000000000002",
        customerPhone: "60123001234",
      }, db);
      assert.equal(mismatch, null);
      assert.equal((await repo.bindExistingContact(first.id, oldContact, db)).contact_id, oldContact);
      await assert.rejects(
        repo.bindExistingContact(second.id, oldContact, db), /duplicate key|unique constraint/
      );
      const mapped = await repo.senderForContact(oldContact, db);
      assert.equal(mapped.sender_key, "neutro");
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n, 1);
      assert.equal((await db.query(
        "SELECT content FROM messages WHERE contact_id = $1", [oldContact]
      )).rows[0].content, "historical");
      await db.query("UPDATE whatsapp_sender_accounts SET state='disabled' WHERE sender_key='ariel'");
      const disabled = await repo.reservePendingConversation({
        accountId: "200000000000002", phoneNumberId: "100000000000002",
        customerPhone: "60127778888",
      }, db);
      assert.equal(disabled, null);
      const rerun = await runMigrations(scoped, { quiet: true });
      assert.equal(rerun.appliedCount, 0);
    } finally {
      await db.query("SET search_path TO public").catch(() => {});
      await db.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
      await db.end();
    }
  }
);
