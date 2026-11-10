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
  }finally{
    await setup.query("SET search_path TO public").catch(()=>{});
    await setup.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await setup.end();
  }
});
