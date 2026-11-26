"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Client}=require("pg");
if(process.env.TEST_DATABASE_URL&&!process.env.DATABASE_URL)process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
const {pool}=require("../src/db/db");
const contacts=require("../src/db/contactsRepo");
const telegram=require("../src/services/telegramImmediateAlertService");
const webPush=require("../src/services/webPushNotificationService");
test("Postgres preserves distinct full clinical disclosures, deduplicates only exact repeats",{
  skip:!process.env.TEST_DATABASE_URL,
},async()=>{
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  const schema="review_disclosure_"+process.pid+"_"+Date.now();
  const oldQuery=pool.query, oldAlert=telegram.sendAiReviewAlert, oldPush=webPush.sendContactAlertBestEffort;
  const alerts=[],pushes=[];
  await db.connect();
  try{
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    await db.query(`CREATE TABLE contacts(id integer primary key,mode text not null default 'ai',needs_attention boolean not null default false,attention_reason text,updated_at timestamptz default now());
      CREATE TABLE messages(id integer primary key,contact_id integer references contacts(id),role text not null,content text,created_at timestamptz default now(),sent_by_username text,delivery_status text);
      INSERT INTO contacts(id) VALUES (1),(2);`);
    await db.query(fs.readFileSync(path.join(__dirname,"../src/db/migrations/064_ai_review_items.sql"),"utf8"));
    pool.query=(...args)=>db.query(...args);
    telegram.sendAiReviewAlert=async({messageId})=>{alerts.push(messageId);};
    webPush.sendContactAlertBestEffort=({contactId})=>{pushes.push(contactId);};
    const add=async(id,contactId,content,category="clinical")=>{
      await db.query("INSERT INTO messages(id,contact_id,role,content) VALUES($1,$2,'user',$3)",[id,contactId,content]);
      const result=await contacts.setAiReviewAttention(contactId,id,content,category);
      assert.ok(result.ai_review_id);
    };
    await add(1,1,"漏尿问题");
    await add(2,1,"漏尿问题");
    await add(3,1,"漏尿问题，最近也有出血");
    await add(4,2,"漏尿问题");
    await add(5,1,"漏尿问题","information");
    const prefix="history ".repeat(55);
    await add(6,1,prefix+"condition A");
    await add(7,1,prefix+"condition B");
    await db.query("UPDATE ai_review_items SET status='resolved' WHERE contact_id=1");
    await add(8,1,"漏尿问题");
    await contacts.setAiReviewAttention(1,8,"漏尿问题","clinical");
    assert.deepEqual(alerts,[1,3,4,5,6,7,8]);
    assert.equal(pushes.length,7);
    const rows=(await db.query("SELECT inbound_message_id FROM ai_review_items ORDER BY inbound_message_id")).rows;
    assert.deepEqual(rows.map(r=>r.inbound_message_id),[1,2,3,4,5,6,7,8]);
  }finally{
    pool.query=oldQuery;telegram.sendAiReviewAlert=oldAlert;webPush.sendContactAlertBestEffort=oldPush;
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
