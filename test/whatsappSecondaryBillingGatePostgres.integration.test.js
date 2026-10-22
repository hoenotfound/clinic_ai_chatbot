"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { loadMigrations, runMigrations } = require("../src/db/migrationRunner");
const billing = require("../src/db/whatsappSenderBillingGateRepo");
const policy = require("../src/services/whatsappSecondaryPolicyService");

const connectionString = process.env.TEST_DATABASE_URL;
const env = {
  WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED: "true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED: "true",
  WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_WABA_ID: "200000000000001",
  WHATSAPP_PRIMARY_SENDER_KEY: "neutro",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "100000000000002",
  WHATSAPP_SECONDARY_WABA_ID: "200000000000002",
  WHATSAPP_SECONDARY_SENDER_KEY: "ariel",
};

async function isolatedSchema(fn) {
  const db = new Client({ connectionString });
  const schema = "sender_billing_" + process.pid + "_" + Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA " + schema);
    await db.query("SET search_path TO " + schema);
    const database = {
      async connect() {
        const c = new Client({ connectionString });
        await c.connect();
        await c.query("SET search_path TO " + schema);
        return { query: (...a) => c.query(...a), release: () => c.end() };
      },
      async query(...args) {
        return db.query(...args);
      },
    };
    await runMigrations(database, { quiet: true });
    await fn({ db, database });
  } finally {
    await db.query("SET search_path TO public").catch(() => {});
    await db.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await db.end();
  }
}

test("migration 083 is additive, repeatable, and prevents cross-sender reservations",
  { skip: !connectionString }, async () => {
    await isolatedSchema(async ({ db, database }) => {
      assert.equal(loadMigrations().at(-1).version, 93);
      const repeat = await runMigrations(database, { quiet: true });
      assert.equal(repeat.appliedCount, 0);
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n, 0);
      const inserted = await db.query(
        "INSERT INTO whatsapp_sender_accounts " +
        "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
        "VALUES ('neutro','100000000000001','200000000000001','Neutro','active')," +
        "('ariel','100000000000002','200000000000002','Ariel','active') " +
        "RETURNING id,sender_key"
      );
      const ids = Object.fromEntries(inserted.rows.map(x => [x.sender_key, x.id]));
      const contacts = await db.query(
        "INSERT INTO contacts(whatsapp_number,whatsapp_sender_id) " +
        "VALUES('60125550000',$1),('60125550000',$2) " +
        "RETURNING id,whatsapp_sender_id",
        [ids.neutro, ids.ariel]
      );
      const first = contacts.rows[0].id;
      const second = contacts.rows[1].id;
      const conversations = await db.query(
        "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
        "VALUES($1,'60125550000',$3,'bound'),($2,'60125550000',$4,'bound') RETURNING id,sender_id",
        [ids.neutro, ids.ariel, first, second]
      );
      const messages = await db.query(
        "INSERT INTO messages(contact_id,role,content) " +
        "VALUES($1,'assistant','neutro draft'),($2,'assistant','ariel draft') RETURNING id",
        [first, second]
      );
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) " +
        "VALUES($1,$3),($2,$4)",
        [messages.rows[0].id,messages.rows[1].id,
          conversations.rows[0].id,conversations.rows[1].id]
      );
      const blocked = await billing.reserveSecondaryBillingAttempt({
        contactId: first, messageId: messages.rows[0].id,
      }, { database, env });
      assert.equal(blocked.code, "secondary_billing_sender_mismatch");

      const c = { contactId: second, messageId: messages.rows[1].id };
      const reserved = await billing.reserveSecondaryBillingAttempt(c, { database, env });
      assert.equal(reserved.reserved, true);
      assert.equal(reserved.sendAuthorized, false);
      const repeatReservation = await billing.reserveSecondaryBillingAttempt(c, { database, env });
      assert.equal(repeatReservation.code, "secondary_billing_previous_send_unresolved");
      assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_gates")).rows[0].n, 1);
      const owner = (await db.query(
        "SELECT sender_id,contact_id,state FROM whatsapp_sender_billing_gates"
      )).rows[0];
      assert.equal(String(owner.sender_id),String(ids.ariel));
      assert.equal(owner.contact_id,second);
      assert.equal(owner.state,"reserved");

      // A manual SQL bypass cannot bind Ariel billing to a Neutro contact.
      await assert.rejects(
        db.query(
          "INSERT INTO whatsapp_sender_billing_attempts " +
          "(reservation_id,sender_id,contact_id,message_id) " +
          "VALUES('11111111-1111-4111-8111-111111111111',$1,$2,$3)",
          [ids.ariel, first, messages.rows[0].id]
        ),
        /foreign key/i
      );
      const accepted = await billing.recordSecondaryProviderOutcome({
        reservationId: reserved.reservationId, acceptedWamid: "wamid.ariel123",
      }, { database, env });
      assert.equal(accepted.state,"awaiting_pricing");
      assert.equal(accepted.sendAuthorized,false);
      assert.equal((await billing.reserveSecondaryBillingAttempt(c, { database, env })).code,
        "secondary_billing_previous_send_unresolved");
      const repeated = await billing.recordSecondaryProviderOutcome({
        reservationId: reserved.reservationId, acceptedWamid: "wamid.ariel123",
      }, { database, env });
      assert.equal(repeated.recorded,true);
      const mismatch = await billing.recordSecondaryProviderOutcome({
        reservationId: reserved.reservationId, acceptedWamid: "wamid.different",
      }, { database, env });
      assert.equal(mismatch.code,"secondary_billing_reservation_not_found");
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_attempts"
      )).rows[0].n, 1);
      assert.equal((await db.query(
        "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
      )).rows[0].n, 0, "Neutro primary billing gate stays untouched");
    });
  }
);

test("sender policy reads one verified sender's inbound history even for duplicate customer numbers",
  { skip: !connectionString }, async () => {
    await isolatedSchema(async ({ db, database }) => {
      const accounts = (await db.query(
        "INSERT INTO whatsapp_sender_accounts " +
        "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
        "VALUES ('neutro','100000000000001','200000000000001','Neutro','active')," +
        "('ariel','100000000000002','200000000000002','Ariel','active') " +
        "RETURNING id,sender_key"
      )).rows;
      const ids = Object.fromEntries(accounts.map(x => [x.sender_key, x.id]));
      const pair = (await db.query(
        "INSERT INTO contacts(whatsapp_number,whatsapp_sender_id) " +
        "VALUES('60127778888',$1),('60127778888',$2) RETURNING id",
        [ids.neutro,ids.ariel]
      )).rows;
      const sc = (await db.query(
        "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
        "VALUES($1,'60127778888',$3,'bound'),($2,'60127778888',$4,'bound') RETURNING id",
        [ids.neutro,ids.ariel,pair[0].id,pair[1].id]
      )).rows;
      const inbound = (await db.query(
        "INSERT INTO messages(contact_id,role,content,whatsapp_message_id) " +
        "VALUES($1,'user','only neutro inbound','wamid.neutro') RETURNING id",
        [pair[0].id]
      )).rows[0];
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [inbound.id,sc[0].id]
      );
      const ariel = { id: pair[1].id, channel: "whatsapp",
        whatsapp_number: "60127778888" };
      const preview = await policy.previewSecondaryFreeformPolicy(ariel, {
        database, env: { ...env, WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED: "true" },
        now: new Date(),
      });
      assert.equal(preview.code,"secondary_no_verified_inbound");
      assert.equal(preview.sendAuthorized,false);
    });
  }
);


test("two different Ariel customers reserve concurrently without sharing an unresolved billing gate",
 {skip:!connectionString},async()=>{
  await isolatedSchema(async({db,database})=>{
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts " +
      "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
      "VALUES('ariel','100000000000002','200000000000002','Ariel','active') RETURNING id"
    )).rows[0].id;
    const pair=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) " +
      "VALUES('whatsapp','60125551111',$1),('whatsapp','60125552222',$1) RETURNING id,whatsapp_number",
      [sender]
    )).rows;
    const conversations=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
      "VALUES($1,'60125551111',$2,'bound'),($1,'60125552222',$3,'bound') RETURNING id",
      [sender,pair[0].id,pair[1].id]
    )).rows;
    const messages=(await db.query(
      "INSERT INTO messages(contact_id,role,content) " +
      "VALUES($1,'assistant','First customer reply'),($2,'assistant','Second customer reply') RETURNING id",
      [pair[0].id,pair[1].id]
    )).rows;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) " +
      "VALUES($1,$3),($2,$4)",
      [messages[0].id,messages[1].id,conversations[0].id,conversations[1].id]
    );
    const [first,second]=await Promise.all([
      billing.reserveSecondaryBillingAttempt({
        contactId:pair[0].id,messageId:messages[0].id,
      },{database,env}),
      billing.reserveSecondaryBillingAttempt({
        contactId:pair[1].id,messageId:messages[1].id,
      },{database,env}),
    ]);
    assert.equal(first.reserved,true);
    assert.equal(second.reserved,true);
    assert.notEqual(first.reservationId,second.reservationId);
    const gates=(await db.query(
      "SELECT owner_contact_id,contact_id,state FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 ORDER BY owner_contact_id",
      [sender]
    )).rows;
    assert.equal(gates.length,2);
    assert.deepEqual(gates.map(g=>g.state),["reserved","reserved"]);
    assert.equal(gates[0].owner_contact_id,pair[0].id);
    assert.equal(gates[1].owner_contact_id,pair[1].id);
    const duplicate=await billing.reserveSecondaryBillingAttempt({
      contactId:pair[0].id,messageId:messages[0].id,
    },{database,env});
    assert.equal(duplicate.code,"secondary_billing_previous_send_unresolved");
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0);
  });
});


test("provider outcomes of two Ariel customers remain isolated in reversed Meta response order",
 {skip:!connectionString},async()=>{
  await isolatedSchema(async({db,database})=>{
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts " +
      "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
      "VALUES('ariel','100000000000002','200000000000002','Ariel','active') RETURNING id"
    )).rows[0].id;
    const people=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) " +
      "VALUES('whatsapp','60125553331',$1),('whatsapp','60125553332',$1) RETURNING id",
      [sender]
    )).rows;
    const conversations=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
      "VALUES($1,'60125553331',$2,'bound'),($1,'60125553332',$3,'bound') RETURNING id",
      [sender,people[0].id,people[1].id]
    )).rows;
    const messages=(await db.query(
      "INSERT INTO messages(contact_id,role,content) " +
      "VALUES($1,'assistant','A'),($2,'assistant','B') RETURNING id",
      [people[0].id,people[1].id]
    )).rows;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) " +
      "VALUES($1,$3),($2,$4)",
      [messages[0].id,messages[1].id,conversations[0].id,conversations[1].id]
    );
    const a=await billing.reserveSecondaryBillingAttempt({
      contactId:people[0].id,messageId:messages[0].id,
    },{database,env});
    const b=await billing.reserveSecondaryBillingAttempt({
      contactId:people[1].id,messageId:messages[1].id,
    },{database,env});
    assert.equal(a.reserved,true);assert.equal(b.reserved,true);
    const bFirst=await billing.recordSecondaryProviderOutcome({
      reservationId:b.reservationId,acceptedWamid:"wamid.ariel-B",
    },{database,env});
    assert.equal(bFirst.recorded,true);
    let gates=(await db.query(
      "SELECT owner_contact_id,reservation_id,state,wamid FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 ORDER BY owner_contact_id",[sender]
    )).rows;
    assert.equal(gates.length,2);
    assert.equal(gates[0].reservation_id,a.reservationId);
    assert.equal(gates[0].state,"reserved");
    assert.equal(gates[0].wamid,null);
    assert.equal(gates[1].reservation_id,b.reservationId);
    assert.equal(gates[1].wamid,"wamid.ariel-B");
    const aSecond=await billing.recordSecondaryProviderOutcome({
      reservationId:a.reservationId,acceptedWamid:"wamid.ariel-A",
    },{database,env});
    assert.equal(aSecond.recorded,true);
    gates=(await db.query(
      "SELECT owner_contact_id,state,wamid FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 ORDER BY owner_contact_id",[sender]
    )).rows;
    assert.deepEqual(gates.map(g=>g.state),["awaiting_pricing","awaiting_pricing"]);
    assert.deepEqual(gates.map(g=>g.wamid),["wamid.ariel-A","wamid.ariel-B"]);
    const attempts=(await db.query(
      "SELECT contact_id,state,wamid FROM whatsapp_sender_billing_attempts " +
      "WHERE sender_id=$1 ORDER BY contact_id",[sender]
    )).rows;
    assert.deepEqual(attempts.map(x=>x.wamid),["wamid.ariel-A","wamid.ariel-B"]);
    assert.equal((await db.query(
      "SELECT COUNT(*)::int AS n FROM whatsapp_free_only_send_gate"
    )).rows[0].n,0);
  });
});


test("definitive Meta 400 response releases only that customer's gate and retains rejected audit",
 {skip:!connectionString},async()=>{
  await isolatedSchema(async({db,database})=>{
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts " +
      "(sender_key,meta_phone_number_id,meta_account_id,display_name,state) " +
      "VALUES('ariel','100000000000002','200000000000002','Ariel','active') RETURNING id"
    )).rows[0].id;
    const c=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) " +
      "VALUES('whatsapp','60125550123',$1) RETURNING id",[sender]
    )).rows[0].id;
    const sc=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) " +
      "VALUES($1,'60125550123',$2,'bound') RETURNING id",[sender,c]
    )).rows[0].id;
    const m=(await db.query(
      "INSERT INTO messages(contact_id,role,content) VALUES($1,'assistant','failed') RETURNING id",
      [c]
    )).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [m,sc]
    );
    const reserved=await billing.reserveSecondaryBillingAttempt({
      contactId:c,messageId:m,
    },{database,env});
    assert.equal(reserved.reserved,true);
    const result=await billing.recordSecondaryProviderOutcome({
      reservationId:reserved.reservationId,definitivelyRejected:true,
    },{database,env});
    assert.equal(result.recorded,true);
    assert.equal(result.state,"rejected");
    const gate=(await db.query(
      "SELECT state,reservation_id,wamid FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 AND owner_contact_id=$2",[sender,c]
    )).rows[0];
    assert.equal(gate.state,"idle");
    assert.equal(gate.reservation_id,null);
    assert.equal(gate.wamid,null);
    const attempt=(await db.query(
      "SELECT state FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1",
      [reserved.reservationId]
    )).rows[0];
    assert.equal(attempt.state,"rejected");
    assert.equal((await billing.reserveSecondaryBillingAttempt({
      contactId:c,messageId:m,
    },{database,env})).reserved,false,
      "Original saved message cannot be resent after Meta rejects it");
  });
});
