"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");
const repo = require("../src/db/whatsappSenderConversationRepo");
const echoRepo = require("../src/db/whatsappCoexistenceRepo");
const statusRepo = require("../src/db/whatsappDeliveryStatusRepo");
const { primaryBillingContactId } = require("../src/services/whatsappZeroCostGuard");
const { assertStoredSenderSafety } = require("../src/services/whatsappSenderActivationGate");

test("migration 080 allows two contact identities for the same customer while retaining history",
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
      assert.equal(loadMigrations().at(-1).version, 93);
      await runMigrations(scoped, { quiet: true });
      await db.query(
        "INSERT INTO whatsapp_sender_accounts (sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
        "VALUES ('neutro','100000000000001','200000000000001','Neutro','active')," +
        "('ariel','100000000000002','200000000000002','Ariel','active')"
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
      const primaryEnv = {
        WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
        WHATSAPP_WABA_ID: "200000000000001",
      };
      assert.equal(await repo.bindExistingContact(first.id, oldContact, db),
        null, "Legacy contacts cannot bind without verified primary identity");
      assert.equal((await repo.bindExistingContact(first.id, oldContact, db, primaryEnv)).contact_id,
        oldContact);
      assert.equal(await repo.bindExistingContact(second.id, oldContact, db, primaryEnv),
        null, "A second sender cannot claim the primary's legacy contact");
      // Foreign conversation is not permitted to claim a legacy message.
      const historicalId = (await db.query(
        "SELECT id FROM messages WHERE contact_id = $1", [oldContact]
      )).rows[0].id;
      assert.equal(await repo.attachMessageContext({
        messageId: historicalId, contactId: oldContact, conversationId: second.id,
      }, db), null);
      const tagged = await repo.attachMessageContext({
        messageId: historicalId, contactId: oldContact, conversationId: first.id,
      }, db);
      assert.equal(tagged.conversation_id, first.id);
      const replayed = await repo.attachMessageContext({
        messageId: historicalId, contactId: oldContact, conversationId: first.id,
      }, db);
      assert.equal(replayed.conversation_id, first.id);
      assert.equal(await repo.attachMessageContext({
        messageId: historicalId, contactId: oldContact + 9999, conversationId: first.id,
      }, db), null);
      assert.equal(await repo.attachMessageContext({
        messageId: historicalId, contactId: oldContact, conversationId: second.id,
      }, db), null);
      const mapped = await repo.senderForContact(oldContact, db);
      assert.equal(mapped.sender_key, "neutro");
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n, 1);
      assert.equal((await db.query(
        "SELECT content FROM messages WHERE contact_id = $1", [oldContact]
      )).rows[0].content, "historical");
      // The original Neutro contact ID must survive primary sender activation.
      const primary = await repo.claimSenderContact(input("60123001234"), scoped, {
        WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
        WHATSAPP_WABA_ID: "200000000000001",
      });
      assert.equal(primary.id, oldContact);
      const ariel = await repo.claimSenderContact({
        accountId: "200000000000002",
        phoneNumberId: "100000000000002",
        customerPhone: "60123001234",
      }, scoped);
      assert.notEqual(ariel.id, oldContact);
      assert.equal(ariel.whatsapp_number, primary.whatsapp_number);
      assert.equal(ariel.whatsapp_sender_key, "ariel");
      assert.equal(primary.whatsapp_sender_key, "neutro");
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n, 2);
      // The SAME WA customer has independent business-contact records.
      // Every strict billing proof must identify the primary Neutro contact,
      // never infer the business sender from the recipient phone alone.
      assert.equal(await primaryBillingContactId("60123001234", {
        database: db, env: {...primaryEnv,
          WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true"},
        expectedContactId:oldContact,
      }), oldContact);
      assert.equal(await primaryBillingContactId("60123001234", {
        database: db, env:primaryEnv, expectedContactId:ariel.id,
      }), null);
      const scopedProof = await assertStoredSenderSafety({
        database:db,env:{
          ...primaryEnv,WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
          WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
          WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
          WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
          WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
        },
      });
      assert.equal(scopedProof.nonprimaryContacts,1);
      await assert.rejects(assertStoredSenderSafety({
        database:db,env:primaryEnv,
      }), /Unsafe WhatsApp rollback/);

      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM messages WHERE contact_id=$1",
        [oldContact]
      )).rows[0].n, 1);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM messages WHERE contact_id=$1",
        [ariel.id]
      )).rows[0].n, 0);
      const repeated = await repo.claimSenderContact({
        accountId: "200000000000002", phoneNumberId: "100000000000002",
        customerPhone: "0123001234",
      }, scoped);
      assert.equal(repeated.id, ariel.id);
      await assert.rejects(repo.claimSenderContact(input("60123001234"), scoped, {
        WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
        WHATSAPP_WABA_ID: "999999999999999",
      }), /not verified/);
      await assert.rejects(db.query(
        "UPDATE contacts SET whatsapp_sender_id = NULL WHERE id=$1", [oldContact]
      ), /foreign key constraint/);
      const arielMapping = await repo.senderForContact(ariel.id, db);
      const savedEcho = await echoRepo.persistStaffEchoIfNew(
        ariel.id, "staff note", "wamid-ariel-echo", "Business App", null,
        db, arielMapping.conversation_id
      );
      assert.equal(savedEcho.isNew,true);
      assert.equal((await db.query(
        "SELECT conversation_id FROM whatsapp_sender_message_context WHERE message_id=$1",
        [savedEcho.message.id]
      )).rows[0].conversation_id,arielMapping.conversation_id);
      const replay = await echoRepo.persistStaffEchoIfNew(
        ariel.id, "staff note", "wamid-ariel-echo", "Business App", null,
        db, arielMapping.conversation_id
      );
      assert.equal(replay.isNew,false);
      await assert.rejects(echoRepo.persistStaffEchoIfNew(
        ariel.id, "wrong sender", "wamid-ariel-wrong-sender", "Business App", null,
        db, first.id
      ), /sender context mismatch/);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM messages WHERE whatsapp_message_id='wamid-ariel-wrong-sender'"
      )).rows[0].n,0);
      const arielMessage = (await db.query(
        "INSERT INTO messages(contact_id,role,content) VALUES($1,'user','erasable') RETURNING id",
        [ariel.id]
      )).rows[0];
      assert.ok(await repo.attachMessageContext({
        messageId: arielMessage.id, contactId: ariel.id,
        conversationId: arielMapping.conversation_id,
      }, db));
      const primaryStatus = (await db.query(
        "INSERT INTO messages (contact_id,role,content,whatsapp_message_id) " +
        "VALUES($1,'assistant','test','wamid-scope-primary') RETURNING id",
        [oldContact]
      )).rows[0];
      const secondaryStatus = (await db.query(
        "INSERT INTO messages (contact_id,role,content,whatsapp_message_id) " +
        "VALUES($1,'assistant','test','wamid-scope-ariel') RETURNING id",
        [ariel.id]
      )).rows[0];
      const mode={WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
        WHATSAPP_PHONE_NUMBER_ID:primaryEnv.WHATSAPP_PHONE_NUMBER_ID,
        WHATSAPP_WABA_ID:primaryEnv.WHATSAPP_WABA_ID};
      assert.equal((await statusRepo.verifyJobSender({
        wamid:"wamid-scope-primary",
        business_phone_number_id:primaryEnv.WHATSAPP_PHONE_NUMBER_ID,
        business_account_id:primaryEnv.WHATSAPP_WABA_ID,
      },{query:db.query.bind(db),env:mode})).matched,true);
      assert.equal((await statusRepo.verifyJobSender({
        wamid:"wamid-scope-primary",
        business_phone_number_id:"100000000000002",
        business_account_id:"200000000000002",
      },{query:db.query.bind(db),env:mode})).matched,false);
      assert.equal((await statusRepo.verifyJobSender({
        wamid:"wamid-scope-ariel",
        business_phone_number_id:"100000000000002",
        business_account_id:"200000000000002",
      },{query:db.query.bind(db),env:mode})).matched,true);
      assert.equal((await statusRepo.verifyJobSender({
        wamid:"wamid-scope-ariel",
        business_phone_number_id:primaryEnv.WHATSAPP_PHONE_NUMBER_ID,
        business_account_id:primaryEnv.WHATSAPP_WABA_ID,
      },{query:db.query.bind(db),env:mode})).matched,false);
      assert.equal((await statusRepo.verifyJobSender({
        wamid:"wamid-scope-ariel",
      },{query:db.query.bind(db),env:mode})).matched,false);
      assert.equal((await statusRepo.verifyJobSender({
        wamid:"wamid-unknown",
        business_phone_number_id:"100000000000002",
        business_account_id:"200000000000002",
      },{query:db.query.bind(db),env:mode})).matched,null);
      await db.query("DELETE FROM contacts WHERE id=$1", [ariel.id]);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_sender_conversations WHERE contact_id=$1",
        [ariel.id]
      )).rows[0].n, 0);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_sender_message_context WHERE message_id=$1",
        [arielMessage.id]
      )).rows[0].n, 0);
      const localId = (await db.query(
        "INSERT INTO contacts(whatsapp_number) VALUES('01233332222') RETURNING id"
      )).rows[0].id;
      const adopted = await repo.claimSenderContact(input("601233332222"), scoped, primaryEnv);
      assert.equal(adopted.id, localId);
      assert.equal(adopted.whatsapp_number, "601233332222");
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

test("upgrade from migration 077 retains existing Neutro conversations and migration ledger",
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
    const connectionString=process.env.TEST_DATABASE_URL;
    const db=new Client({connectionString});
    const schema="phase2_upgrade_"+process.pid+"_"+Date.now();
    await db.connect();
    try {
      await db.query("CREATE SCHEMA "+schema);
      await db.query("SET search_path TO "+schema);
      const scoped={
        async connect() {
          const client=new Client({connectionString});
          await client.connect();
          await client.query("SET search_path TO "+schema);
          return {query:(...args)=>client.query(...args),release:()=>client.end()};
        },
      };
      const all=loadMigrations();
      assert.equal(all.at(-1).version,93);
      const first=await runMigrations(scoped,{
        quiet:true,migrations:all.filter(m=>m.version<=77)
      });
      assert.equal(first.currentVersion,77);
      const old=(await db.query(
        "INSERT INTO contacts(whatsapp_number,whatsapp_profile_name) " +
        "VALUES('60123335555','Historic Neutro') RETURNING id"
      )).rows[0].id;
      const message=(await db.query(
        "INSERT INTO messages(contact_id,role,content) " +
        "VALUES($1,'user','existing customer enquiry') RETURNING id",[old]
      )).rows[0].id;
      const upgraded=await runMigrations(scoped,{quiet:true});
      assert.equal(upgraded.appliedCount,16);
      assert.equal(upgraded.currentVersion,93);
      const proof=(await db.query(
        "SELECT c.id,c.whatsapp_number,c.whatsapp_sender_id,m.id AS message_id, " +
        "m.content FROM contacts c JOIN messages m ON m.contact_id=c.id " +
        "WHERE c.id=$1",[old]
      )).rows;
      assert.equal(proof.length,1);
      assert.equal(proof[0].id,old);
      assert.equal(proof[0].message_id,message);
      assert.equal(proof[0].content,"existing customer enquiry");
      assert.equal(proof[0].whatsapp_sender_id,null);
      assert.equal((await db.query("SELECT MAX(version)::int AS latest, " +
        "COUNT(*)::int AS total FROM schema_migrations")).rows[0].latest,93);
      assert.equal((await db.query("SELECT COUNT(*)::int AS total " +
        "FROM whatsapp_sender_accounts")).rows[0].total,0);
      await assert.rejects(db.query(
        "INSERT INTO contacts(whatsapp_number) VALUES('60123335555')"
      ),/duplicate key/);
      assert.equal((await runMigrations(scoped,{quiet:true})).appliedCount,0);
    } finally {
      await db.query("SET search_path TO public").catch(()=>{});
      await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
      await db.end();
    }
  }
);
