"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const imageQueue = require("../src/services/whatsappResultMediaQueue");

const connectionString = process.env.TEST_DATABASE_URL;

test("Postgres: original result audit constraint, migration, receipt states and failed delivery",{
  skip:!connectionString,
},async()=>{
  const client = new Client({connectionString});
  const schema = "queued_images_" + process.pid + "_" + Date.now();
  await client.connect();
  try{
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(`
      CREATE TABLE contacts (id INTEGER PRIMARY KEY);
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id),
        role TEXT, whatsapp_message_id TEXT, delivery_status TEXT
      );
      INSERT INTO contacts(id) VALUES (1);
      INSERT INTO messages(id,contact_id,role) VALUES (10,1,'user');
      INSERT INTO messages(id,contact_id,role,whatsapp_message_id,delivery_status)
      VALUES (11,1,'assistant','wamid.image.1','pending'),
             (12,1,'assistant',null,null);
    `);
    for(const name of [
      "065_result_media_decisions.sql",
      "068_whatsapp_result_media_queue.sql",
      "069_whatsapp_result_media_delivery.sql",
    ]) {
      await client.query(fs.readFileSync(path.join(__dirname,"../src/db/migrations",name),"utf8"));
    }
    await client.query(`
      INSERT INTO whatsapp_result_media_queue
        (contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption,
         status,message_id,provider_delivery_status)
      VALUES (1,10,0,'result','https://example.test/result1','First','sent',11,null),
             (1,10,1,'result','https://example.test/result2','Second','pending',null,null);
    `);
    await imageQueue.reconcileAudit(10,client);
    let audit = (await client.query("SELECT status,reason,result_images_sent FROM result_media_decisions WHERE inbound_message_id=10")).rows[0];
    assert.equal(audit.status,"deferred");
    assert.equal(audit.result_images_sent,0);

    await client.query("UPDATE messages SET delivery_status='sent' WHERE id=11");
    await imageQueue.reconcileProviderDelivery("wamid.image.1",client);
    audit = (await client.query("SELECT status,result_images_sent FROM result_media_decisions WHERE inbound_message_id=10")).rows[0];
    assert.equal(audit.status,"deferred");
    assert.equal(audit.result_images_sent,0,
      "accepted by Meta does not prove the image reached the customer");

    await client.query("UPDATE messages SET delivery_status='delivered' WHERE id=11");
    await imageQueue.reconcileProviderDelivery("wamid.image.1",client);
    audit = (await client.query("SELECT status,result_images_sent FROM result_media_decisions WHERE inbound_message_id=10")).rows[0];
    assert.equal(audit.status,"deferred",
      "second result still pending even though first is delivered");
    assert.equal(audit.result_images_sent,1);

    await client.query("UPDATE messages SET delivery_status='failed' WHERE id=11");
    await imageQueue.reconcileProviderDelivery("wamid.image.1",client);
    const rows = (await client.query(
      "SELECT sequence_no,status,provider_delivery_status,reason FROM whatsapp_result_media_queue ORDER BY sequence_no"
    )).rows;
    assert.equal(rows[0].status,"failed");
    assert.equal(rows[0].provider_delivery_status,"failed");
    assert.equal(rows[1].status,"cancelled",
      "remaining queued images are not sent after Meta reports failure");
    audit = (await client.query("SELECT status,reason,result_images_sent FROM result_media_decisions WHERE inbound_message_id=10")).rows[0];
    assert.equal(audit.status,"failed");
    assert.equal(audit.result_images_sent,0,
      "late failure corrects an earlier confirmed delivery count");

    await client.query(`
      INSERT INTO messages(id,contact_id,role) VALUES(20,1,'user');
      INSERT INTO messages(id,contact_id,role,whatsapp_message_id,delivery_status)
      VALUES(21,1,'assistant','wamid.image.2','read');
      INSERT INTO whatsapp_result_media_queue
        (contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption,status,message_id)
      VALUES(1,20,0,'result','https://example.test/result3','Third','sent',21);
    `);
    await imageQueue.reconcileAudit(20,client);
    await imageQueue.reconcileProviderDelivery("wamid.image.2",client);
    audit = (await client.query("SELECT status,result_images_sent FROM result_media_decisions WHERE inbound_message_id=20")).rows[0];
    assert.equal(audit.status,"sent");
    assert.equal(audit.result_images_sent,1);
    await client.query(`
      INSERT INTO messages(id,contact_id,role) VALUES(30,1,'user');
      INSERT INTO messages(id,contact_id,role,whatsapp_message_id,delivery_status)
        VALUES(31,1,'assistant','wamid.promo.1','delivered');
      INSERT INTO whatsapp_result_media_queue
        (contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption,status,message_id)
        VALUES(1,30,0,'promotion','https://example.test/promo','Promo','sent',31);
    `);
    await imageQueue.reconcileAudit(30,client);
    await imageQueue.reconcileProviderDelivery("wamid.promo.1",client);
    const promoOnly=(await client.query(
      "SELECT status,reason,promotion_images_sent,result_images_sent FROM result_media_decisions WHERE inbound_message_id=30"
    )).rows[0];
    assert.equal(promoOnly.status,"skipped",
      "a promo-only queue is not an indefinitely deferred result image decision");
    assert.equal(promoOnly.promotion_images_sent,1);
    assert.equal(promoOnly.result_images_sent,0);

    await imageQueue.reconcileProviderDelivery("wamid.image.2",client);
    assert.equal((await client.query("SELECT COUNT(*)::int AS total FROM result_media_decisions WHERE inbound_message_id=20")).rows[0].total,1,
      "callback replay remains idempotent");
  }finally{
    await client.query("SET search_path TO public").catch(()=>{});
    await client.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await client.end();
  }
});

test("Postgres: primary result eligibility preserves questions but blocks real supersession",{
  skip:!connectionString,
},async()=>{
  const client=new Client({connectionString});
  const schema="result_continuation_"+process.pid+"_"+Date.now();
  await client.connect();
  try{
    await client.query("CREATE SCHEMA "+schema);
    await client.query("SET search_path TO "+schema);
    await client.query(
      "CREATE TABLE contacts (id INTEGER PRIMARY KEY);"+
      "CREATE TABLE messages ("+
        "id INTEGER PRIMARY KEY,contact_id INTEGER NOT NULL REFERENCES contacts(id),"+
        "role TEXT,content TEXT,created_at TIMESTAMPTZ NOT NULL,"+
        "sent_by_username TEXT,whatsapp_message_id TEXT,delivery_status TEXT"+
      ");"
    );
    for(const name of [
      "065_result_media_decisions.sql",
      "068_whatsapp_result_media_queue.sql",
      "069_whatsapp_result_media_delivery.sql",
    ]) {
      await client.query(fs.readFileSync(
        path.join(__dirname,"../src/db/migrations",name),"utf8"));
    }
    let nextContact=100,nextMessage=1000;
    async function superseded(original,reply,{
      newPlan=null,staff=false,kind="result",
    }={}){
      const contactId=nextContact++,oldId=nextMessage++,newId=nextMessage++;
      await client.query("INSERT INTO contacts(id) VALUES($1)",[contactId]);
      await client.query(
        "INSERT INTO messages(id,contact_id,role,content,created_at)"+
        "VALUES($1,$2,'user',$3,NOW()-INTERVAL '2 minutes')",
        [oldId,contactId,original]);
      await client.query(
        "INSERT INTO messages(id,contact_id,role,content,created_at,sent_by_username)"+
        "VALUES($1,$2,$3,$4,NOW()-INTERVAL '1 minute',$5)",
        [newId,contactId,staff?"assistant":"user",reply,staff?"nurse":null]);
      if(newPlan){
        await client.query(
          "INSERT INTO whatsapp_result_media_queue"+
          "(contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption)"+
          "VALUES($1,$2,0,$3,'https://example.test/new.jpg','New image')",
          [contactId,newId,newPlan]);
      }
      const result=await client.query(
        imageQueue.RESULT_CONVERSATION_CHANGED_SQL,[contactId,oldId,kind]);
      return result.rows[0]?.changed;
    }
    assert.equal(await superseded(
      "你好！想了解你们家的【黄金脉冲技术】","地址在哪"),false);
    assert.equal(await superseded("想了解骨盆调理","多少钱"),false);
    assert.equal(await superseded("想了解3D小颜术","四方脸"),false);
    assert.equal(await superseded("想了解骨盆调理","四方脸"),true);
    assert.equal(await superseded("想了解3D小颜术","想了解9D逆龄"),true);
    assert.equal(await superseded("想了解骨盆调理","想了解脉冲波"),true);
    assert.equal(await superseded("想了解骨盆调理","我是腹直肌分离"),true);
    assert.equal(await superseded("想了解黄金脉冲技术","Stop promotions"),true);
    assert.equal(await superseded("想了解黄金脉冲技术","地址在哪",{
      newPlan:"promotion"}),false,"pricing graphic must not erase an old result");
    assert.equal(await superseded("想了解黄金脉冲技术","地址在哪",{
      newPlan:"result"}),true,"fresh result replaces an old result");
    assert.equal(await superseded("想了解骨盆调理","We can take over",{
      staff:true}),true,"staff takeover blocks a queued result");
    assert.equal(await superseded("想了解骨盆调理","地址在哪",{
      kind:"promotion"}),true,"promotional media keeps its previous cancellation rule");
  }finally{
    await client.query("SET search_path TO public").catch(()=>{});
    await client.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await client.end();
  }
});
