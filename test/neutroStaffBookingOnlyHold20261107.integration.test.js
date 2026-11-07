"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {temporaryStaffConversationSql}=require("../src/utils/temporaryStaffConversation");

const URL=process.env.TEST_DATABASE_URL;
test("staff's general question no longer pauses AI; verified appointment work still does",{
 skip:!URL,
},async()=>{
 const db=new Client({connectionString:URL});
 const schema="staff_only_"+process.pid+"_"+Date.now();
 await db.connect();
 let created=false;
 try {
  await db.query('CREATE SCHEMA "'+schema+'"');
  created=true;
  await db.query('SET search_path TO "'+schema+'"');
  await db.query([
   "CREATE TABLE contacts(id INT PRIMARY KEY);",
   "CREATE TABLE leads(id INT PRIMARY KEY,contact_id INT);",
   "CREATE TABLE messages(id INT PRIMARY KEY,contact_id INT,role TEXT,content TEXT,sent_by_username TEXT,whatsapp_message_id TEXT,is_automated_follow_up BOOLEAN DEFAULT FALSE,is_forwarded BOOLEAN DEFAULT FALSE,media_mime_type TEXT,delivery_status TEXT,created_at TIMESTAMPTZ);",
   "CREATE TABLE lead_activities(id SERIAL PRIMARY KEY,lead_id INT,metadata JSONB);",
   "INSERT INTO contacts(id) VALUES(1),(2),(3),(4),(5);",
   "INSERT INTO leads(id,contact_id) VALUES(10,3);",
   // Contact 1 reproduces MC GOH's staff menu followed by 'i ask previously'.
   "INSERT INTO messages VALUES(101,1,'user','hi',NULL,'wamid.101',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '20 minutes');",
   "INSERT INTO messages VALUES(102,1,'assistant','May I check which treatment you are asking about, Pelvic / 3D / 9D?', 'admin','wamid.102',FALSE,FALSE,NULL,'delivered',NOW()-INTERVAL '10 minutes');",
   "INSERT INTO messages VALUES(103,1,'user','i ask previously',NULL,'wamid.103',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '9 minutes');",
   // An actual appointment conversation from the customer and staff remains protected.
   "INSERT INTO messages VALUES(201,2,'user','Can I book an appointment?',NULL,'wamid.201',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '20 minutes');",
   "INSERT INTO messages VALUES(202,2,'assistant','Your appointment can be tomorrow at 3pm, okay?','admin','wamid.202',FALSE,FALSE,NULL,'delivered',NOW()-INTERVAL '10 minutes');",
   "INSERT INTO messages VALUES(203,2,'user','yes',NULL,'wamid.203',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '9 minutes');",
   // Verified durable reminders must still block even without appointment keywords.
   "INSERT INTO messages VALUES(301,3,'user','hi',NULL,'wamid.301',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '20 minutes');",
   "INSERT INTO messages VALUES(302,3,'assistant','See you soon','admin','wamid.302',FALSE,FALSE,NULL,'delivered',NOW()-INTERVAL '10 minutes');",
   "INSERT INTO messages VALUES(303,3,'user','ok',NULL,'wamid.303',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '9 minutes');",
   "INSERT INTO lead_activities(lead_id,metadata) VALUES(10,'{\"outcome\":\"staff_appointment_reminder\",\"staffMessageId\":\"302\"}');",
   // An unrelated staff introduction about a promotion does not pause the AI.
   "INSERT INTO messages VALUES(401,4,'user','What is 3D?',NULL,'wamid.401',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '20 minutes');",
   "INSERT INTO messages VALUES(402,4,'assistant','Can I confirm the treatment you want?', 'admin','wamid.402',FALSE,FALSE,NULL,'delivered',NOW()-INTERVAL '10 minutes');",
   "INSERT INTO messages VALUES(403,4,'user','3D please',NULL,'wamid.403',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '9 minutes');",
   // A staff message that is forwarded or a failed send is never booking ownership.
   "INSERT INTO messages VALUES(501,5,'user','I want to book an appointment',NULL,'wamid.501',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '20 minutes');",
   "INSERT INTO messages VALUES(502,5,'assistant','Booking an appointment?','admin','wamid.502',FALSE,TRUE,NULL,'delivered',NOW()-INTERVAL '10 minutes');",
   "INSERT INTO messages VALUES(503,5,'user','yes',NULL,'wamid.503',FALSE,FALSE,NULL,NULL,NOW()-INTERVAL '9 minutes');",
  ].join("\n"));
  const query=(appointmentOnly) => "SELECT "+temporaryStaffConversationSql("c","inbound",{appointmentOnly})+
   " AS staff_active FROM contacts c JOIN messages inbound ON inbound.contact_id=c.id AND inbound.role='user' WHERE c.id=$1 AND inbound.id=$2";
  const check=async(contactId,inboundMessageId,appointmentOnly=true) =>
   (await db.query(query(appointmentOnly),[contactId,inboundMessageId])).rows[0].staff_active;
  assert.equal(await check(1,103,false),true,"legacy broad predicate still protects marketing follow-ups");
  assert.equal(await check(1,103),false,"routine staff question must not silence direct AI");
  assert.equal(await check(4,403),false,"confirming a treatment is not an appointment");
  assert.equal(await check(2,203),true,"verified two-party booking coordination remains staff-owned");
  assert.equal(await check(3,303),true,"durable appointment reminder still blocks AI");
  assert.equal(await check(5,503),false,"forwarded staff message does not create a hold");

  // Once a reminder is explicitly invalidated, the next reply may use AI.
  await db.query("INSERT INTO lead_activities(lead_id,metadata) VALUES(10,'{\"outcome\":\"staff_reminder_invalidated\",\"staffMessageId\":\"302\"}')");
  assert.equal(await check(3,303),false,"invalidated reminder releases staff booking-only hold");

  // A new AI response between staff and customer re-establishes AI ownership.
  await db.query("INSERT INTO messages VALUES(204,2,'assistant','We will confirm your slot','',NULL,FALSE,FALSE,NULL,'sent',NOW()-INTERVAL '9 minutes 30 seconds')");
  // Staff's message must still be the most recent before the inbound. This
  // synthetic reply precedes the customer message but postdates staff.
  await db.query("UPDATE messages SET sent_by_username=NULL WHERE id=204");
  assert.equal(await check(2,203),false,"intervening AI reply ends the staff-only hold");
 } finally {
  await db.query("SET search_path TO public").catch(()=>{});
  if(created) await db.query('DROP SCHEMA "'+schema+'" CASCADE').catch(()=>{});
  await db.end();
 }
});
