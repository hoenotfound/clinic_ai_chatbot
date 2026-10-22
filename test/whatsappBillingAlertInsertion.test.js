"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Client}=require("pg");
const repo=require("../src/db/whatsappDeliveryStatusRepo");
const guard=require("../src/services/whatsappZeroCostGuard");

// Guard this contract even without TEST_DATABASE_URL. A billable marketing
// callback must never be lost because its category differs from 'service'.
test("billing-alert insertion uses durable service proof, not a category-only filter",async()=>{
  const sql=[];
  const query=async (statement,args)=>{
    sql.push({statement,args});
    return {rows:[]};
  };
  const previous=process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_PHONE_NUMBER_ID="test-phone";
  try {
    await repo.storeBatch([
      {wamid:"wa.marketing",status:"sent",pricingType:"regular",
       pricingCategory:"marketing",pricingBillable:true},
      {wamid:"wa.unclassified",status:"delivered",pricingType:"regular",
       pricingBillable:true},
      {wamid:"wa.no-type",status:"sent",pricingBillable:true},
    ],query);
  } finally {
    if(previous===undefined)delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID=previous;
  }
  const inserts=sql.filter(x=>x.statement.includes(
    "INSERT INTO whatsapp_free_only_billing_alerts"));
  assert.equal(inserts.length,3);
  for(const entry of inserts){
    assert.match(entry.statement,/receipt\.pricing_category='service'/);
    assert.match(entry.statement,/receipt\.billable=true/);
    assert.match(entry.statement,/ex\.status='accepted'/);
    assert.doesNotMatch(entry.statement,/AND \$3='regular'/);
    assert.equal(entry.args.length,2);
  }
  const unknown=sql.find(x=>x.statement.includes(
    "INSERT INTO whatsapp_free_entry_pricing_evidence") &&
    x.args[0]==="wa.no-type");
  assert.equal(unknown.args[1],"unknown");
});

test("Postgres: expected service charges exempt; marketing, unknown, conflicting and early callbacks alert",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
  const schema="wa_billing_"+process.pid+"_"+Date.now();
  const phone=process.env.WHATSAPP_PHONE_NUMBER_ID;
  process.env.WHATSAPP_PHONE_NUMBER_ID="test-phone";
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    await db.query(`
      CREATE TABLE contacts (id INTEGER PRIMARY KEY);
      CREATE TABLE messages (id INTEGER PRIMARY KEY);
      INSERT INTO contacts VALUES(1);
      INSERT INTO messages VALUES(10),(11),(12);
    `);
    for(const name of [
      "014_whatsapp_delivery_status_jobs.sql",
      "054_whatsapp_free_entry_followups.sql",
      "059_whatsapp_free_only_safety.sql",
      "070_whatsapp_24h_service_reply_exceptions.sql",
      "082_whatsapp_delivery_sender_provenance.sql",
    ]) await db.query(fs.readFileSync(path.join(
      __dirname,"../src/db/migrations",name),"utf8"));

    const send=async(wamid,type,category,billable=true,status="sent")=>
      repo.storeBatch([{wamid,status,pricingType:type,
        pricingCategory:category,pricingBillable:billable}],
        db.query.bind(db));
    const alerted=async(wamid)=>{
      const v=await db.query(`SELECT count(*)::integer AS n
        FROM whatsapp_free_only_billing_alerts WHERE wamid=$1`,[wamid]);
      return v.rows[0].n;
    };
    await db.query(`INSERT INTO whatsapp_24h_service_reply_exceptions
      (message_id,contact_id,status,wamid)
      VALUES(10,1,'accepted','wa.expected')`);
    await send("wa.expected","regular","service");
    assert.equal(await alerted("wa.expected"),0,
      "verified, accepted service charge is not unexpected");

    await send("wa.marketing","regular","marketing");
    await send("wa.no-category","regular",null);
    await send("wa.no-type",null,null);
    await send("wa.billable-fep","free_entry_point",null);
    for(const wamid of ["wa.marketing","wa.no-category","wa.no-type","wa.billable-fep"]){
      assert.equal(await alerted(wamid),1,"unexpected callback: "+wamid);
    }

    // Meta's webhook arrives after reservation but before local acceptance.
    await db.query(`INSERT INTO whatsapp_24h_service_reply_exceptions
      (message_id,contact_id,status) VALUES(11,1,'reserved')`);
    await send("wa.early","regular","service");
    assert.equal(await alerted("wa.early"),1);
    await guard.complete24hServiceReply(11,
      {success:true,wamid:"wa.early"},db);
    assert.equal(await alerted("wa.early"),0,
      "accepted and verified early webhook is cleared safely");

    // Local Meta acceptance can also precede its pricing webhook.
    await db.query(`INSERT INTO whatsapp_24h_service_reply_exceptions
      (message_id,contact_id,status,wamid)
      VALUES(12,1,'accepted','wa.late')`);
    await send("wa.late","regular","service");
    assert.equal(await alerted("wa.late"),0);

    // A later category correction must create an unexpected alert, even
    // for the same WAMID that initially had accepted service proof.
    await send("wa.expected","regular","marketing",true,"delivered");
    const correction=await db.query(`SELECT pricing_category FROM
      whatsapp_free_entry_pricing_evidence WHERE wamid='wa.expected'`);
    assert.equal(correction.rows[0].pricing_category,"conflicting");
    assert.equal(await alerted("wa.expected"),1);
    await send("wa.expected","regular","marketing",true,"read");
    assert.equal(await alerted("wa.expected"),1,"duplicate webhook stays unique");

    // No billing callback -> no speculative billing alarm.
    await send("wa.free","free_entry_point",null,false);
    assert.equal(await alerted("wa.free"),0);
  } finally {
    await db.query("RESET search_path").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
    if(phone===undefined)delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID=phone;
  }
});
