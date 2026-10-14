"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Client}=require("pg");
const guard=require("../src/services/whatsappZeroCostGuard");
const whatsapp=require("../src/services/whatsappService");
const config=require("../src/config/clinicConfig");

function enableAuto(t,allowed=true) {
  const old=config.automatedFollowUp;
  config.automatedFollowUp={
    ...old, whatsappFreeOnly: {
      enabled:true, activatedAt:"2026-10-13T03:34:05.624Z",
      allow24hServiceReplies:true,allow24hStaffMedia:true,
      allow24hAutoFollowUps:allowed,
    },
  };
  t.after(()=>{ config.automatedFollowUp=old; });
}

test("auto follow-up 24h lane defaults off; templates and unrelated sends cannot use it",async t=>{
  enableAuto(t,false);
  let queries=0;
  const db={query:async()=>{queries++;return {rows:[{message_id:100}]};}};
  for(const kind of ["auto_followup_text","auto_followup_media"]) {
    assert.equal(await guard.reserve24hServiceReply("60121234567",{
      database:db,context:{messageKind:kind,currentMessageId:100},
    }),null);
  }
  assert.equal(queries,0);
  config.automatedFollowUp.whatsappFreeOnly.allow24hAutoFollowUps=true;
  for(const kind of ["template","interactive_consent","media","marketing","freeform"]) {
    assert.equal(await guard.reserve24hServiceReply("60121234567",{
      database:db,context:{messageKind:kind,currentMessageId:100},
    }),null);
  }
  assert.equal(await guard.reserve24hServiceReply("60121234567",{
    database:db,context:{
      messageKind:"auto_followup_media",currentMessageId:100,currentFollowUpAttemptId:33,
    },
  }),null,"extended CTWA template attempt cannot impersonate an ordinary follow-up");
  assert.equal(queries,0);
});

test("WhatsApp wrappers preserve text/video/image follow-up kind without trusting staff flag",async t=>{
  enableAuto(t,true);
  const seen=[];
  t.mock.method(guard,"perform",async (_to,_operation,ctx)=>{
    seen.push(ctx);return {success:false,policyBlocked:true};
  });
  await whatsapp.sendMessage("60121234567","check-in",{
    currentMessageId:10,autoFollowUp:true,
  });
  await whatsapp.sendImage("60121234567","https://invalid.test/photo","caption",{
    currentMessageId:11,autoFollowUp:true,
  });
  await whatsapp.sendVideoById("60121234567","video-id","caption",{
    currentMessageId:12,autoFollowUp:true,
  });
  assert.deepEqual(seen.slice(0,3),[
    {currentMessageId:10,messageKind:"auto_followup_text"},
    {currentMessageId:11,messageKind:"auto_followup_media"},
    {currentMessageId:12,messageKind:"auto_followup_media"},
  ]);
  await whatsapp.sendMessage("60121234567","normal",{currentMessageId:13});
  await whatsapp.sendVideoById("60121234567","video-id","",{
    currentMessageId:14,staffMedia:true,
  });
  assert.deepEqual(seen.slice(3),[
    {currentMessageId:13,messageKind:"first_reply_text"},
    {currentMessageId:14,messageKind:"staff_media"},
  ]);
});

test("Postgres: only genuine in-window follow-up steps 1-3 reserve; duplicates and other automations rejected",
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  enableAuto(t,true);
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
  const schema="wa_auto_fu_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    await db.query(`
      CREATE TABLE contacts(id INTEGER PRIMARY KEY,channel TEXT,whatsapp_number TEXT);
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,contact_id INTEGER REFERENCES contacts(id),
        role TEXT,created_at TIMESTAMPTZ,whatsapp_message_id TEXT,
        whatsapp_template JSONB,is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
        automated_follow_up_step INTEGER NOT NULL DEFAULT 1,
        automated_follow_up_for_message_id INTEGER,
        automated_follow_up_parent_message_id INTEGER,pricing_reminder_anchor_id INTEGER,
        sent_by_username TEXT,media_mime_type TEXT,media_url TEXT,media_key TEXT
      );
      CREATE TABLE whatsapp_free_entry_followup_attempts(id SERIAL PRIMARY KEY,message_id INTEGER);
      CREATE TABLE scheduled_messages(message_id INTEGER);
      CREATE TABLE whatsapp_free_only_billing_alerts(wamid TEXT PRIMARY KEY,sent_at TIMESTAMPTZ);
      CREATE TABLE whatsapp_free_entry_pricing_evidence(
        wamid TEXT PRIMARY KEY,pricing_type TEXT,billable BOOLEAN,
        delivery_status TEXT,updated_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO contacts VALUES(1,'whatsapp','60121234567'),
        (2,'whatsapp','60129999999'),(3,'facebook','60123333333');
      INSERT INTO messages(id,contact_id,role,created_at,whatsapp_message_id)
        VALUES
        (1,1,'user',now()-interval '2 hours','wamid.inbound'),
        (2,1,'assistant',now()-interval '90 minutes','wamid.anchor'),
        (3,2,'user',now()-interval '25 hours','wamid.old'),
        (4,2,'assistant',now()-interval '24 hours','wamid.old.anchor'),
        (5,3,'user',now()-interval '2 hours','fb.inbound'),
        (6,3,'assistant',now()-interval '90 minutes','fb.anchor');
      INSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up,
        automated_follow_up_for_message_id,sent_by_username,media_url,media_key,media_mime_type,
        automated_follow_up_step)
      VALUES
        (10,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation','',NULL,NULL,1),
        (11,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation',NULL,'shared-video.mp4','video/mp4',2),
        (12,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation','https://invalid.test/result.jpg',NULL,NULL,3),
        (13,1,'assistant',now()-interval '1 minute',false,2,'admin',NULL,NULL,NULL,1),
        (14,1,'assistant',now()-interval '1 minute',true,NULL,'Follow-up automation',NULL,NULL,NULL,1),
        (15,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation',NULL,NULL,NULL,1),
        (16,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation',NULL,NULL,NULL,1),
        (17,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation',NULL,NULL,NULL,1),
        (18,1,'assistant',now()-interval '1 minute',true,2,'Other automation',NULL,NULL,NULL,1),
        (19,2,'assistant',now()-interval '23 hours',true,4,'Follow-up automation',NULL,NULL,NULL,1),
        (20,3,'assistant',now()-interval '1 minute',true,6,'Follow-up automation',NULL,NULL,NULL,1),
        (21,1,'assistant',now()-interval '1 minute',true,2,'Follow-up automation','https://invalid.test/image.jpg',NULL,NULL,1);
      UPDATE messages SET pricing_reminder_anchor_id=2 WHERE id=15;
      INSERT INTO scheduled_messages(message_id) VALUES(16);
      UPDATE messages SET whatsapp_template='{"name":"ns_fu"}'::jsonb WHERE id=17;
      INSERT INTO whatsapp_free_entry_followup_attempts(message_id) VALUES(18);
      UPDATE messages SET sent_by_username='Other automation' WHERE id=18;
    `);
    for(const migration of [
      "070_whatsapp_24h_service_reply_exceptions.sql",
      "072_whatsapp_24h_staff_media.sql",
      "075_whatsapp_24h_automated_followups.sql",
    ]) await db.query(fs.readFileSync(path.join(__dirname,"../src/db/migrations",migration),"utf8"));
    const ctx=(id,kind)=>({
      database:db,context:{messageKind:kind,currentMessageId:id},
    });
    for(const [id,kind,sendKind] of [
      [10,"auto_followup_text","auto_followup_text"],
      [11,"auto_followup_media","auto_followup_media"],
      [12,"auto_followup_media","auto_followup_media"],
    ]) {
      const permitted=await guard.reserve24hServiceReply("60121234567",ctx(id,kind));
      assert.equal(permitted?.allowed,true,"allowed genuine follow-up "+id);
      assert.equal((await guard.reserve24hServiceReply("60121234567",ctx(id,kind))).code,
        "zero_cost_service_reply_already_attempted","cannot double-send "+id);
      const stored=await db.query("SELECT send_kind,status FROM whatsapp_24h_service_reply_exceptions WHERE message_id=$1",[id]);
      assert.deepEqual(stored.rows,[{send_kind:sendKind,status:"reserved"}]);
    }
    for(const id of [13,14,15,16,17,18,19,20,21]) {
      const recipient=id===19?"60129999999":id===20?"60123333333":"60121234567";
      const kind=id===21?"auto_followup_text":"auto_followup_text";
      assert.equal(await guard.reserve24hServiceReply(recipient,ctx(id,kind)),null,
        "unrelated, wrong media kind, scheduled, template, unverified, expired, social or promo "+id);
    }
    await guard.complete24hServiceReply(11,{success:true,wamid:"wamid.video"},db);
    const accepted=await db.query("SELECT status,send_kind,wamid FROM whatsapp_24h_service_reply_exceptions WHERE message_id=11");
    assert.deepEqual(accepted.rows,[{
      status:"accepted",send_kind:"auto_followup_media",wamid:"wamid.video",
    }]);
    config.automatedFollowUp.whatsappFreeOnly.allow24hAutoFollowUps=false;
    assert.equal(await guard.reserve24hServiceReply("60121234567",ctx(21,"auto_followup_media")),null,
      "disabling feature stops new exceptions immediately");
  } finally {
    await db.query("RESET search_path").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
