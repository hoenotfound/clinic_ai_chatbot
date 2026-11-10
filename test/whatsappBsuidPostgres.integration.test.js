"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const { Client }=require("pg");
const { loadMigrations,runMigrations }=require("../src/db/migrationRunner");
const senderContacts=require("../src/db/whatsappSenderConversationRepo");
const connectionString=process.env.TEST_DATABASE_URL;

test("Postgres: signed phone and BSUID inbound reuse one sender-bound contact",
  {skip:!connectionString},async()=>{
  const setup=new Client({connectionString});
  const schema="bsuid_ci_"+process.pid+"_"+Date.now();
  await setup.connect();
  try{
    await setup.query("CREATE SCHEMA "+schema);
    await setup.query("SET search_path TO "+schema);
    const pool={
      async connect(){
        const client=new Client({connectionString});
        await client.connect();
        await client.query("SET search_path TO "+schema);
        return {query:(...args)=>client.query(...args),release:()=>client.end()};
      },
    };
    const migrated=await runMigrations(pool,{quiet:true,migrations:loadMigrations()});
    assert.ok(migrated.currentVersion>=120);
    const snapshotColumn=await setup.query(
      "SELECT column_name FROM information_schema.columns " +
      "WHERE table_schema=current_schema() " +
      "AND table_name='whatsapp_sender_billing_attempts' " +
      "AND column_name='recipient_address'");
    assert.equal(snapshotColumn.rowCount,1);
    await setup.query(
      "INSERT INTO whatsapp_sender_accounts "+
      "(sender_key,meta_phone_number_id,meta_account_id,display_name,state,coexistence_enabled) "+
      "VALUES('neutro_secondary','100000000000002','200000000000002','Neutro','active',true)"
    );
    const sender={accountId:"200000000000002",phoneNumberId:"100000000000002"};
    const env={WHATSAPP_PHONE_NUMBER_ID:"100000000000001",
      WHATSAPP_WABA_ID:"200000000000001",WHATSAPP_PRIMARY_SENDER_KEY:"neutro"};
    const bsuid="MY.Abc123XYZ";
    const first=await senderContacts.claimSenderContact({
      ...sender,customerPhone:"60123456789",customerUserId:bsuid,
      customerUsername:"@peggy",profileName:"Guest",
    },pool,env);
    assert.equal(first.whatsapp_number,"60123456789");
    assert.equal(first.whatsapp_user_id,bsuid);

    const hidden=await senderContacts.claimSenderContact({
      ...sender,customerPhone:bsuid,customerUserId:bsuid,
      customerUsername:"@peggyteoh",
    },pool,env);
    assert.equal(hidden.id,first.id);
    assert.equal(hidden.whatsapp_number,"60123456789",
      "stable phone key keeps saved history and lead ownership");
    assert.equal(hidden.whatsapp_last_customer_address,bsuid);
    assert.equal(hidden.whatsapp_username,"@peggyteoh");
    const businessEcho=await senderContacts.claimSenderContact({
      ...sender,customerPhone:"60123456789",customerUserId:bsuid,
      preserveLastCustomerAddress:true,
    },pool,env);
    assert.equal(businessEcho.id,first.id);
    assert.equal(businessEcho.whatsapp_last_customer_address,bsuid,
      "staff echo must never rewrite a customer's last inbound address");
    const owner=await senderContacts.findBoundContactForSender({
      ...sender,customerPhone:bsuid},setup);
    assert.equal(owner.id,first.id);
    const count=await setup.query("SELECT COUNT(*)::integer n FROM contacts");
    assert.equal(count.rows[0].n,1);

    await assert.rejects(senderContacts.claimSenderContact({
      ...sender,customerPhone:"MY.Different",customerUserId:bsuid,
    },pool,env),/identity mismatch/);

    const second=await senderContacts.claimSenderContact({
      ...sender,customerPhone:"MY.OtherBsuid",customerUserId:"MY.OtherBsuid",
    },pool,env);
    assert.notEqual(second.id,first.id);
    assert.equal(second.whatsapp_number,"MY.OtherBsuid");
    const rows=await setup.query(
      "SELECT customer_wa_id FROM whatsapp_sender_conversations ORDER BY id");
    assert.deepEqual(rows.rows.map(x=>x.customer_wa_id),
      ["60123456789","MY.OtherBsuid"]);

    const conflictingRotation=await senderContacts.rotateSenderUserId({
      ...sender,previousUserId:bsuid,newUserId:"MY.OtherBsuid",
    },pool);
    assert.deepEqual(conflictingRotation,
      {updated:false,reason:"replacement_identity_already_bound"});
    const rotated=await senderContacts.rotateSenderUserId({
      ...sender,previousUserId:bsuid,newUserId:"MY.RotatedABC",
    },pool);
    assert.equal(rotated.updated,true);
    assert.equal(rotated.contactId,first.id);
    const existing=await senderContacts.claimSenderContact({
      ...sender,customerPhone:"MY.RotatedABC",customerUserId:"MY.RotatedABC",
    },pool,env);
    assert.equal(existing.id,first.id);
    assert.equal(existing.whatsapp_number,"60123456789");
    assert.equal(existing.whatsapp_last_customer_address,"MY.RotatedABC");
    assert.equal((await senderContacts.rotateSenderUserId({
      ...sender,previousUserId:bsuid,newUserId:"MY.RotatedABC",
    },pool)).updated,false,"signed rotation replay must be idempotent");

    const withNewPhone=await senderContacts.rotateSenderUserId({
      ...sender,previousUserId:"MY.RotatedABC",
      newUserId:"MY.RotatedAgain",newPhone:"60129876543",
    },pool);
    assert.equal(withNewPhone.updated,true);
    const updated=await setup.query(
      "SELECT whatsapp_number,whatsapp_user_id,whatsapp_last_customer_address " +
      "FROM contacts WHERE id=$1",[first.id]);
    assert.equal(updated.rows[0].whatsapp_number,"60123456789",
      "preserve historical conversation ownership");
    assert.equal(updated.rows[0].whatsapp_user_id,"MY.RotatedAgain");
    assert.equal(updated.rows[0].whatsapp_last_customer_address,"60129876543",
      "new phone number may be used only when provided by signed Meta system event");
    const delayedOld=await senderContacts.claimSenderContact({
      ...sender,customerPhone:bsuid,customerUserId:bsuid,
    },pool,env);
    assert.equal(delayedOld.id,first.id,
      "late signed messages from previous IDs retain the original contact");
    assert.equal(delayedOld.whatsapp_user_id,"MY.RotatedAgain");
    assert.equal(delayedOld.whatsapp_last_customer_address,"60129876543",
      "old user-ID messages must not roll the recipient backward");
    const aliases=await setup.query(
      "SELECT previous_user_id,replacement_user_id FROM whatsapp_sender_user_id_aliases " +
      "ORDER BY previous_user_id");
    assert.deepEqual(aliases.rows,[
      {previous_user_id:bsuid,replacement_user_id:"MY.RotatedABC"},
      {previous_user_id:"MY.RotatedABC",replacement_user_id:"MY.RotatedAgain"},
    ]);
    const beforeConcurrent=(await setup.query(
      "SELECT count(*)::integer n FROM contacts")).rows[0].n;
    // Both operations require the same sender-scoped advisory locks. Either
    // ordering must keep a single contact, without losing a delayed old turn.
    const [concurrentRotation, concurrentOld]=await Promise.all([
      senderContacts.rotateSenderUserId({
        ...sender,previousUserId:"MY.RotatedAgain",
        newUserId:"MY.ConcurrentFinal",
      },pool),
      senderContacts.claimSenderContact({
        ...sender,customerPhone:"MY.RotatedAgain",
        customerUserId:"MY.RotatedAgain",
      },pool,env),
    ]);
    assert.equal(concurrentRotation.updated,true);
    assert.equal(concurrentOld.id,first.id);
    assert.equal((await setup.query(
      "SELECT count(*)::integer n FROM contacts")).rows[0].n,
      beforeConcurrent);
    const latest=await setup.query(
      "SELECT whatsapp_user_id,whatsapp_last_customer_address FROM contacts WHERE id=$1",
      [first.id]);
    assert.equal(latest.rows[0].whatsapp_user_id,"MY.ConcurrentFinal");
    assert.equal(latest.rows[0].whatsapp_last_customer_address,"MY.ConcurrentFinal");

    // Hold both DB locks while an inbound claims the replacement user ID on
    // a separate connection. It must wait for the rotation and reuse owner.
    let reachedNewLock;
    const newLockReached=new Promise(resolve=>{reachedNewLock=resolve;});
    let releaseRotation;
    const rotationUnblock=new Promise(resolve=>{releaseRotation=resolve;});
    const newId="MY.QueuedNewID";
    const pausedPool={
      async connect() {
        const client=await pool.connect();
        return {
          query:async(sql,...args)=>{
            const result=await client.query(sql,...args);
            if (String(sql).includes("pg_advisory_xact_lock") &&
                args[0]?.[1]===newId) {
              reachedNewLock();
              await rotationUnblock;
            }
            return result;
          },
          release:()=>client.release(),
        };
      },
    };
    const rotating=senderContacts.rotateSenderUserId({
      ...sender,previousUserId:"MY.ConcurrentFinal",newUserId:newId,
    },pausedPool);
    await newLockReached;
    const claiming=senderContacts.claimSenderContact({
      ...sender,customerPhone:newId,customerUserId:newId,
    },pool,env);
    releaseRotation();
    const [rotationResult,claimResult]=await Promise.all([rotating,claiming]);
    assert.equal(rotationResult.updated,true);
    assert.equal(claimResult.id,first.id);
    const finalCount=await setup.query("SELECT count(*)::integer n FROM contacts");
    assert.equal(finalCount.rows[0].n,2);
  }finally{
    await setup.query("SET search_path TO public").catch(()=>{});
    await setup.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await setup.end();
  }
});
