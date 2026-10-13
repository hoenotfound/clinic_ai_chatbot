"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const guard = require("../src/services/whatsappZeroCostGuard");
const whatsapp = require("../src/services/whatsappService");
const clinicConfig = require("../src/config/clinicConfig");

function enableMedia(t, allowed = true) {
  const before = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = {
    ...before,
    whatsappFreeOnly: { enabled: true, allow24hServiceReplies: true,
      allow24hStaffMedia: allowed, activatedAt: "2026-10-13T03:34:05Z" },
  };
  t.after(() => { clinicConfig.automatedFollowUp = before; });
}

test("media opt-in is independent of text and never authorizes automation by default", async t => {
  enableMedia(t, false);
  let count = 0;
  const database = { query: async () => { count++; return {rows:[{message_id:1}]}; } };
  assert.equal(await guard.reserve24hServiceReply("60120000000", {
    database, context: {messageKind:"staff_media",currentMessageId:1},
  }), null);
  assert.equal(count,0);
  clinicConfig.automatedFollowUp.whatsappFreeOnly.allow24hStaffMedia = true;
  for(const kind of ["template","media","interactive_consent","marketing","first_reply_media"]) {
    assert.equal(await guard.reserve24hServiceReply("60120000000", {
      database,context:{messageKind:kind,currentMessageId:1},
    }),null,kind);
  }
  assert.equal(await guard.reserve24hServiceReply("60120000000",{
    database,context:{messageKind:"staff_media",currentMessageId:1,currentFollowUpAttemptId:4},
  }),null);
  assert.equal(count,0);
});

test("WhatsApp media wrappers require an explicit staff-media marker",async t=>{
  const contexts=[];
  t.mock.method(guard,"perform",async (_to,_op,ctx)=>{
    contexts.push(ctx);
    return {success:false,policyBlocked:true};
  });
  const id=45,to="60121234567";
  await whatsapp.sendImage(to,"https://example.invalid/image.jpg","",{
    currentMessageId:id,staffMedia:true,
  });
  await whatsapp.sendImageById(to,"image-id","",{currentMessageId:id,staffMedia:true});
  await whatsapp.sendVideoById(to,"video-id","",{currentMessageId:id,staffMedia:true});
  await whatsapp.sendDocumentById(to,"file-id","file.pdf","",{currentMessageId:id,staffMedia:true});
  await whatsapp.sendStickerById(to,"sticker-id",{currentMessageId:id,staffMedia:true});
  await whatsapp.sendVoiceById(to,"voice-id",{currentMessageId:id,staffMedia:true});
  assert.equal(contexts.length,6);
  for(const ctx of contexts)assert.deepEqual(ctx,{currentMessageId:id,messageKind:"staff_media"});
  await whatsapp.sendImageById(to,"image-id","",{currentMessageId:id});
  assert.deepEqual(contexts[6],{currentMessageId:id,messageKind:"media"});
  await whatsapp.sendMessage(to,"hello",{currentMessageId:id,staffMedia:true});
  assert.equal(contexts[7].messageKind,"first_reply_text",
    "staff media flag cannot reclassify a text or a template");
});

test("Postgres: staff-originated media eligible for a genuine 24h inbound; other paths blocked",{
  skip:!process.env.TEST_DATABASE_URL,
},async t=>{
  enableMedia(t,true);
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
  const schema="wa_staff_media_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    await db.query(`
      CREATE TABLE contacts(
        id INTEGER PRIMARY KEY,channel TEXT,whatsapp_number TEXT);
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,contact_id INTEGER REFERENCES contacts(id),
        role TEXT,created_at TIMESTAMPTZ,whatsapp_message_id TEXT,
        whatsapp_template JSONB,is_automated_follow_up BOOLEAN,
        automated_follow_up_step INTEGER,automated_follow_up_parent_message_id INTEGER,
        pricing_reminder_anchor_id INTEGER,sent_by_username TEXT,media_mime_type TEXT
      );
      CREATE TABLE whatsapp_free_entry_followup_attempts(
        id SERIAL PRIMARY KEY,message_id INTEGER);
      CREATE TABLE scheduled_messages(message_id INTEGER);
      CREATE TABLE whatsapp_free_only_billing_alerts(
        wamid TEXT PRIMARY KEY,sent_at TIMESTAMPTZ);
      CREATE TABLE whatsapp_free_entry_pricing_evidence(
        wamid TEXT PRIMARY KEY,pricing_type TEXT,billable BOOLEAN,
        delivery_status TEXT,updated_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO contacts VALUES
        (1,'whatsapp','60121234567'),(2,'facebook','60129999999');
      INSERT INTO messages(id,contact_id,role,created_at,whatsapp_message_id)
        VALUES(1,1,'user',now()-interval '10 minutes','wamid.real.inbound');
      INSERT INTO messages(id,contact_id,role,created_at,media_mime_type,sent_by_username)
        VALUES
        (10,1,'assistant',now()-interval '2 minutes','image/png','admin'),
        (11,1,'assistant',now()-interval '2 minutes','video/mp4','admin'),
        (12,1,'assistant',now()-interval '2 minutes','image/png',NULL),
        (13,1,'assistant',now()-interval '2 minutes',NULL,'admin'),
        (14,1,'assistant',now()-interval '25 hours','image/png','admin'),
        (15,1,'assistant',now()-interval '2 minutes','image/png','admin'),
        (16,1,'assistant',now()-interval '2 minutes','image/png','admin'),
        (17,2,'assistant',now()-interval '2 minutes','image/png','admin'),
        (18,1,'assistant',now()-interval '2 minutes','image/png','admin');
      UPDATE messages SET is_automated_follow_up=true WHERE id=15;
      INSERT INTO scheduled_messages(message_id) VALUES(16);
      INSERT INTO whatsapp_free_entry_followup_attempts(message_id) VALUES(18);
    `);
    for(const version of ["070_whatsapp_24h_service_reply_exceptions.sql",
      "071_whatsapp_24h_staff_media.sql"])await db.query(
      fs.readFileSync(path.join(__dirname,"../src/db/migrations",version),"utf8"));
    const ctx=id=>({database:db,context:{
      messageKind:"staff_media",currentMessageId:id}});
    const first=await guard.reserve24hServiceReply("60121234567",ctx(10));
    assert.equal(first.allowed,true,"ordinary staff photo allowed");
    const one=await db.query("SELECT send_kind,status FROM whatsapp_24h_service_reply_exceptions");
    assert.deepEqual(one.rows,[{send_kind:"staff_media",status:"reserved"}]);
    const duplicate=await guard.reserve24hServiceReply("60121234567",ctx(10));
    assert.equal(duplicate.code,"zero_cost_service_reply_already_attempted");
    const second=await guard.reserve24hServiceReply("60121234567",ctx(11));
    assert.equal(second.allowed,true,"ordinary staff video allowed");
    for(const id of [12,13,14,15,16,17,18])
      assert.equal(await guard.reserve24hServiceReply("60121234567",ctx(id)),
        null,"cannot authorize nonstaff, nonmedia, old, scheduled or automated id "+id);
    assert.equal(await guard.reserve24hServiceReply("60129999999",ctx(10)),null);
    await guard.complete24hServiceReply(10,{success:true,wamid:"wamid.photo"},db);
    const proof=await db.query(`
      SELECT send_kind,wamid,status FROM whatsapp_24h_service_reply_exceptions
      WHERE message_id=10`);
    assert.deepEqual(proof.rows,[{send_kind:"staff_media",wamid:"wamid.photo",
      status:"accepted"}]);
    clinicConfig.automatedFollowUp.whatsappFreeOnly.allow24hStaffMedia=false;
    assert.equal(await guard.reserve24hServiceReply("60121234567",ctx(11)),null,
      "disabling the switch immediately stops the media lane");
  } finally {
    await db.query("RESET search_path").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
