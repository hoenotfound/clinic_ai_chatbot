"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {createStaffBookingConfirmationService}=require("../src/services/staffBookingConfirmationService");
const {pendingAcceptedAppointmentAllowedSql}=require("../src/utils/pendingAcceptedAppointmentFollowUp");
const {INVALIDATE_SQL}=require("../src/db/staffAppointmentReminderRepo");
const connectionString=process.env.TEST_DATABASE_URL;

test("verified staff reminder persists once, suppresses sales, and reopens only for a later genuine enquiry",{
  skip:!connectionString,
},async()=>{
  const db=new Client({connectionString});
  const schema="staff_reminder_"+process.pid+"_"+Date.now();
  await db.connect();
  let created=false;
  try{
    await db.query("CREATE SCHEMA "+schema);
    created=true;
    await db.query("SET search_path TO "+schema);
    await db.query([
      "CREATE TABLE contacts(id INT PRIMARY KEY, mode TEXT, channel TEXT DEFAULT 'whatsapp');",
      "CREATE TABLE leads(id INT PRIMARY KEY,contact_id INT,is_closed BOOLEAN,appointment_status TEXT,created_at TIMESTAMPTZ DEFAULT now());",
      "CREATE TABLE messages(id INT PRIMARY KEY,contact_id INT,role TEXT,content TEXT,sent_by_username TEXT,whatsapp_message_id TEXT,is_forwarded BOOLEAN DEFAULT false,media_mime_type TEXT,is_automated_follow_up BOOLEAN DEFAULT false,delivery_status TEXT,created_at TIMESTAMPTZ DEFAULT now());",
      "CREATE TABLE lead_activities(id SERIAL PRIMARY KEY,lead_id INT,activity_type TEXT,description TEXT,actor TEXT,metadata JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ DEFAULT now());",
      "INSERT INTO contacts(id,mode) VALUES(1005,'ai');",
      "INSERT INTO leads(id,contact_id,is_closed,appointment_status,created_at) VALUES(792,1005,false,'none',NOW()-INTERVAL '10 days');",
      "INSERT INTO messages(id,contact_id,role,content,sent_by_username,whatsapp_message_id,is_automated_follow_up,delivery_status,created_at) VALUES(17279,1005,'assistant','Morning dear remind appointment tmr 11.30am 😊','WhatsApp Business App','wamid.staff17279',false,'sent',NOW()-INTERVAL '5 days');"
    ].join("\n"));
    const service=createStaffBookingConfirmationService({
      config:{businessType:"tcm_clinic"},
      database:{connect:async()=>({query:db.query.bind(db),release(){}})},
      pipeline:{getActiveLeadForContact:async()=>{throw Error("A reminder must not create a CRM appointment");}},
    });
    const firstText="Morning dear remind appointment tmr 11.30am 😊";
    assert.equal(await service(1005,firstText,{providerAccepted:true,messageId:17279}),null);
    assert.equal(await service(1005,firstText,{providerAccepted:true,messageId:17279}),null);
    assert.equal((await db.query("SELECT count(*)::int n FROM lead_activities")).rows[0].n,1);
    const guard="SELECT "+pendingAcceptedAppointmentAllowedSql("c")+" AS eligible FROM contacts c WHERE c.id=1005";
    assert.equal((await db.query(guard)).rows[0].eligible,false);
    await db.query("INSERT INTO messages(id,contact_id,role,content,whatsapp_message_id,created_at) VALUES(17280,1005,'user','ok','wamid.ok',NOW()-INTERVAL '4 days 23 hours')");
    assert.equal((await db.query(guard)).rows[0].eligible,false);
    await db.query("INSERT INTO messages(id,contact_id,role,content,whatsapp_message_id,created_at) VALUES(17281,1005,'user','I want to know about 9D','wamid.9d',NOW()-INTERVAL '20 hours')");
    assert.equal((await db.query(guard)).rows[0].eligible,true);
    await db.query("INSERT INTO messages(id,contact_id,role,content,sent_by_username,whatsapp_message_id,delivery_status,created_at) VALUES(17282,1005,'assistant','Reminder: your appointment is tomorrow at 11:30am','WhatsApp Business App','wamid.next','delivered',NOW()-INTERVAL '2 hours')");
    assert.equal(await service(1005,"Reminder: your appointment is tomorrow at 11:30am",{providerAccepted:true,messageId:17282}),null);
    assert.equal((await db.query(guard)).rows[0].eligible,false);
    // Editing a reminder to a tentative offer immediately releases only
    // this provider message's hold, without changing the CRM booking status.
    await db.query("UPDATE messages SET content='Appointment tomorrow 11.30am if it suits you' WHERE id=17282");
    await db.query(INVALIDATE_SQL,[1005,17282,9001]);
    assert.equal((await db.query(guard)).rows[0].eligible,true);
    await db.query("UPDATE messages SET content='Reminder: your appointment is tomorrow at 11:30am' WHERE id=17282");
    await service(1005,"Reminder: your appointment is tomorrow at 11:30am",{providerAccepted:true,messageId:17282});
    assert.equal((await db.query(guard)).rows[0].eligible,false);
    await db.query("UPDATE messages SET content='🗑️ [Message deleted from WhatsApp Business App]' WHERE id=17282");
    await db.query(INVALIDATE_SQL,[1005,17282,9002]);
    assert.equal((await db.query(guard)).rows[0].eligible,true);
    await db.query(INVALIDATE_SQL,[1005,17282,9002]);
    assert.equal((await db.query("SELECT count(*)::int n FROM lead_activities WHERE metadata->>'outcome'='staff_reminder_invalidated'")).rows[0].n,2);
    await db.query("INSERT INTO lead_activities(lead_id,activity_type,description,actor,metadata) VALUES(792,'updated','Reviewed','Staff','{\"outcome\":\"booking_hold_resolved\"}'::jsonb)");
    assert.equal((await db.query(guard)).rows[0].eligible,true);
    await db.query("INSERT INTO messages(id,contact_id,role,content,sent_by_username,created_at) VALUES(17283,1005,'assistant','Reminder: your appointment is tomorrow at 11:30am','WhatsApp Business App',NOW())");
    await service(1005,"Reminder: your appointment is tomorrow at 11:30am",{providerAccepted:true,messageId:17283});
    assert.equal((await db.query("SELECT count(*)::int n FROM lead_activities WHERE metadata->>'outcome'='staff_appointment_reminder'")).rows[0].n,3);
    await db.query("UPDATE lead_activities SET created_at=NOW()-INTERVAL '31 days' WHERE metadata->>'outcome'='staff_appointment_reminder'");
    assert.equal((await db.query(guard)).rows[0].eligible,true);
    assert.equal((await db.query("SELECT appointment_status FROM leads WHERE id=792")).rows[0].appointment_status,"none");
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    if(created)await db.query("DROP SCHEMA "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
