"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {Client}=require("pg");
const guard=require("../src/services/whatsappZeroCostGuard");
const config=require("../src/config/clinicConfig");

// The new option is opt-in per clinic and does not disable strict template checks.
function serviceMode(t,allowed=true) {
  const old=config.automatedFollowUp;
  config.automatedFollowUp={
    ...old,whatsappFreeOnly:{
      enabled:true,allow24hServiceReplies:allowed,
      activatedAt:"2026-10-13T03:34:05.624Z",
    },
  };
  t.after(()=>{config.automatedFollowUp=old;});
}

test("24h service lane defaults off and never bypasses media or templates",async t=>{
  serviceMode(t,false);
  let touched=0;
  const db={query:async()=>{touched++;return {rows:[{message_id:100}]};}};
  assert.equal(await guard.reserve24hServiceReply("60121234567",{
    database:db,context:{messageKind:"first_reply_text",currentMessageId:100}
  }),null);
  assert.equal(touched,0);
  config.automatedFollowUp.whatsappFreeOnly.allow24hServiceReplies=true;
  for(const messageKind of ["template","interactive_consent","freeform","media"]) {
    assert.equal(await guard.reserve24hServiceReply("60121234567",{
      database:db,context:{messageKind,currentMessageId:100}
    }),null);
  }
  assert.equal(await guard.reserve24hServiceReply("60121234567",{
    database:db,context:{messageKind:"first_reply_text",
      currentMessageId:100,currentFollowUpAttemptId:55}
  }),null);
  assert.equal(touched,0);
});

test("service lane needs a persisted message and cannot replay the same provider attempt",async t=>{
  serviceMode(t,true);
  const rows=new Map();const calls=[];
  const db={async query(sql,args){
    calls.push({sql,args});
    if(sql.includes("INSERT INTO whatsapp_24h_service_reply_exceptions")) {
      if(rows.has(args[0]))return {rows:[]};
      rows.set(args[0],{status:"reserved"});
      return {rows:[{message_id:args[0]}]};
    }
    if(sql.includes("SELECT 1 FROM whatsapp_24h_service_reply_exceptions"))
      return {rows:rows.has(args[0]) && args[1]==="60121234567"
        ?[{exists:1}]:[]};
    if(sql.includes("UPDATE whatsapp_24h_service_reply_exceptions")) {
      const row=rows.get(args[0]); if(row?.status==="reserved"){row.status=args[1];row.wamid=args[2];}
      return {rows:[]};
    }
    if(sql.includes("DELETE FROM whatsapp_24h_service_reply_exceptions")) {
      if(rows.get(args[0])?.status==="reserved")rows.delete(args[0]);
      return {rows:[]};
    }
    if(sql.includes("DELETE FROM whatsapp_free_only_billing_alerts"))return {rows:[]};
    throw new Error("Unexpected SQL");
  }};
  assert.equal(await guard.reserve24hServiceReply("bad",{
    database:db,context:{messageKind:"first_reply_text",currentMessageId:100}}),null);
  assert.equal(await guard.reserve24hServiceReply("60121234567",{
    database:db,context:{messageKind:"first_reply_text"}}),null);
  const args={database:db,context:{messageKind:"first_reply_text",currentMessageId:100}};
  const first=await guard.reserve24hServiceReply("60121234567",args);
  assert.equal(first.serviceReplyMessageId,100);
  assert.equal(first.reservationId,null);
  const duplicate=await guard.reserve24hServiceReply("60121234567",args);
  assert.equal(duplicate.allowed,false);
  assert.equal(duplicate.code,"zero_cost_service_reply_already_attempted");
  await guard.complete24hServiceReply(100,{success:true,wamid:"wamid.service"},db);
  assert.deepEqual(rows.get(100),{status:"accepted",wamid:"wamid.service"});
  assert.equal(calls.some(x=>x.sql.includes("DELETE FROM whatsapp_free_only_billing_alerts")),true);
  await guard.complete24hServiceReply(100,{success:false,ambiguous:true},db);
  assert.equal(rows.get(100).status,"accepted");
  const otherArgs={database:db,context:{messageKind:"first_reply_text",currentMessageId:101}};
  assert.equal((await guard.reserve24hServiceReply("60121234567",otherArgs)).allowed,true);
  await guard.complete24hServiceReply(101,{success:false,providerStatus:400,providerRejected:true},db);
  assert.equal(rows.has(101),false,"definite Meta 4xx may release the one-shot reservation");
  assert.equal((await guard.reserve24hServiceReply("60121234567",otherArgs)).allowed,true);
  await guard.complete24hServiceReply(101,{success:false,ambiguous:true},db);
  assert.equal(rows.get(101)?.status,"unknown","ambiguous sends stay reserved");
  assert.equal((await guard.reserve24hServiceReply("60121234567",otherArgs)).code,
    "zero_cost_service_reply_already_attempted");
});

test("service reply SQL excludes automated messages and requires recent provider-authored inbound",async t=>{
  serviceMode(t,true);
  let query="";
  const db={async query(sql){
    if(sql.includes("INSERT INTO whatsapp_24h_service_reply_exceptions")) query=sql;
    return {rows:[]};
  }};
  await guard.reserve24hServiceReply("60121234567",{
    database:db,context:{messageKind:"first_reply_text",currentMessageId:234}
  });
  for(const snippet of [
    "m.whatsapp_template IS NULL","m.is_automated_follow_up IS NOT TRUE",
    "m.automated_follow_up_parent_message_id IS NULL","m.pricing_reminder_anchor_id IS NULL",
    "whatsapp_free_entry_followup_attempts","scheduled_messages","inbound.whatsapp_message_id IS NOT NULL",
    "interval '23 hours 58 minutes'","ON CONFLICT(message_id) DO NOTHING",
  ])assert.ok(query.includes(snippet),snippet);
  assert.equal(query.includes("m.automated_follow_up_step IS NULL"),false,
    "Production defaults the step to 1 even for ordinary messages");
  assert.ok(guard.VERIFIED_WINDOW_SQL.includes("whatsapp_24h_service_reply_exceptions"));
  const templateCode=fs.readFileSync(path.join(__dirname,"../src/services/whatsappTemplateService.js"),"utf8");
  assert.match(templateCode,/messageKind:\s*"template"/);
});

test("Postgres: 24h organic text allowed, old, unverified, follow-up and template messages denied",
  {skip:!process.env.TEST_DATABASE_URL},async t=>{
  serviceMode(t,true);
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
  const schema="wa_service_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    await db.query(`
      CREATE TABLE contacts(id INTEGER PRIMARY KEY,channel TEXT,whatsapp_number TEXT);
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,contact_id INTEGER REFERENCES contacts(id),
        role TEXT,created_at TIMESTAMPTZ, whatsapp_message_id TEXT,
        whatsapp_template JSONB,is_automated_follow_up BOOLEAN NOT NULL DEFAULT false,
        automated_follow_up_step INTEGER NOT NULL DEFAULT 1,
        automated_follow_up_parent_message_id INTEGER,
        pricing_reminder_anchor_id INTEGER,
        sent_by_username TEXT,media_mime_type TEXT
      );
      CREATE TABLE whatsapp_free_entry_followup_attempts(id SERIAL PRIMARY KEY,message_id INTEGER);
      CREATE TABLE whatsapp_free_only_billing_alerts(wamid TEXT PRIMARY KEY,sent_at TIMESTAMPTZ);
      CREATE TABLE scheduled_messages(message_id INTEGER);
      CREATE TABLE whatsapp_free_entry_pricing_evidence (
        wamid TEXT PRIMARY KEY,pricing_type TEXT,billable BOOLEAN,
        delivery_status TEXT,updated_at TIMESTAMPTZ DEFAULT now()
      );
      INSERT INTO contacts VALUES(1,'whatsapp','60121234567');
      INSERT INTO messages(id,contact_id,role,created_at,whatsapp_message_id)
      VALUES(1,1,'user',now()-interval '2 minutes','wamid.inbound');
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES(10,1,'assistant',now()-interval '1 minute');
      INSERT INTO messages(id,contact_id,role,created_at,is_automated_follow_up)
      VALUES(11,1,'assistant',now()-interval '1 minute',true);
      INSERT INTO messages(id,contact_id,role,created_at,whatsapp_template)
      VALUES(12,1,'assistant',now()-interval '1 minute','{"name":"test"}'::jsonb);
      INSERT INTO messages(id,contact_id,role,created_at,pricing_reminder_anchor_id)
      VALUES(13,1,'assistant',now()-interval '1 minute',1);
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES(14,1,'assistant',now()-interval '25 hours');
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES(15,1,'assistant',now()-interval '1 minute');
      INSERT INTO whatsapp_free_entry_followup_attempts(message_id) VALUES(15);
      INSERT INTO messages(id,contact_id,role,created_at)
      VALUES(16,1,'assistant',now()-interval '1 minute');
      INSERT INTO scheduled_messages(message_id) VALUES(16);
    `);
    await db.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/070_whatsapp_24h_service_reply_exceptions.sql"),"utf8"));
    await db.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/072_whatsapp_24h_staff_media.sql"),"utf8"));
    const ctx=(id)=>({database:db,context:{messageKind:"first_reply_text",currentMessageId:id}});
    const ordinary=await db.query("SELECT automated_follow_up_step,is_automated_follow_up FROM messages WHERE id=10");
    assert.deepEqual(ordinary.rows,[{automated_follow_up_step:1,is_automated_follow_up:false}]);
    assert.equal((await guard.reserve24hServiceReply("60121234567",ctx(10))).allowed,true);
    assert.equal((await guard.reserve24hServiceReply("60121234567",ctx(10))).code,
      "zero_cost_service_reply_already_attempted");
    for(const id of [11,12,13,14,15,16]) {
      assert.equal(await guard.reserve24hServiceReply("60121234567",ctx(id)),null,"blocked "+id);
    }
    assert.equal(await guard.reserve24hServiceReply("60129999999",ctx(10)),null);
    await guard.complete24hServiceReply(10,{success:true,wamid:"wamid.service"},db);
    const proof=await db.query("SELECT status,wamid FROM whatsapp_24h_service_reply_exceptions");
    assert.deepEqual(proof.rows,[{status:"accepted",wamid:"wamid.service"}]);
    await db.query("DELETE FROM messages WHERE id=10");
    const retained=await db.query(
      "SELECT message_id,wamid,status FROM whatsapp_24h_service_reply_exceptions");
    assert.deepEqual(retained.rows,[{message_id:null,wamid:"wamid.service",status:"accepted"}]);
    const none=await db.query(`SELECT EXISTS(
      SELECT 1 FROM whatsapp_24h_service_reply_exceptions
      WHERE wamid='wamid.unknown' AND status='accepted') AS exempt`);
    assert.equal(none.rows[0].exempt,false);
    // Verified ordinary service charges are expected, but marketing and
    // unknown pricing categories must NOT be excluded from billing alarms.
    await db.query(`
      INSERT INTO whatsapp_free_entry_pricing_evidence
        (wamid,pricing_type,billable,delivery_status,pricing_category)
      VALUES('wamid.service','regular',true,'delivered','service')
    `);
    const serviceAlarm=await db.query(`
      SELECT EXISTS(SELECT 1 FROM whatsapp_free_entry_pricing_evidence p
       WHERE p.billable=true AND NOT EXISTS (
         SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
          WHERE ex.wamid=p.wamid AND ex.status='accepted'
            AND p.pricing_type='regular' AND p.pricing_category='service'
       )) AS tripped
    `);
    assert.equal(serviceAlarm.rows[0].tripped,false);
    await db.query(`UPDATE whatsapp_free_entry_pricing_evidence
      SET pricing_category='marketing' WHERE wamid='wamid.service'`);
    const unexpected=await db.query(`
      SELECT EXISTS(SELECT 1 FROM whatsapp_free_entry_pricing_evidence p
       WHERE p.billable=true AND NOT EXISTS (
         SELECT 1 FROM whatsapp_24h_service_reply_exceptions ex
          WHERE ex.wamid=p.wamid AND ex.status='accepted'
            AND p.pricing_type='regular' AND p.pricing_category='service'
       )) AS tripped
    `);
    assert.equal(unexpected.rows[0].tripped,true);
  } finally {
    await db.query("RESET search_path").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
