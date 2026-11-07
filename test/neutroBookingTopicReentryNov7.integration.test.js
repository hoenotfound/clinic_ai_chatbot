"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {temporaryStaffConversationSql}=require("../src/utils/temporaryStaffConversation");
const url=process.env.TEST_DATABASE_URL;

test("booking-only staff hold recognises natural appointments and releases unrelated treatment topics",{
 skip:!url,
},async()=>{
 const db=new Client({connectionString:url});
 const schema="booking_topic_"+process.pid+"_"+Date.now();
 await db.connect();
 let created=false;
 try{
  await db.query('CREATE SCHEMA "'+schema+'"');
  created=true;
  await db.query('SET search_path TO "'+schema+'"');
  await db.query([
   "CREATE TABLE contacts(id INT PRIMARY KEY);",
   "CREATE TABLE leads(id INT PRIMARY KEY,contact_id INT);",
   "CREATE TABLE lead_activities(id SERIAL PRIMARY KEY,lead_id INT,metadata JSONB);",
   "CREATE TABLE messages(id INT PRIMARY KEY,contact_id INT,role TEXT,content TEXT,sent_by_username TEXT,whatsapp_message_id TEXT,delivery_status TEXT,media_mime_type TEXT,is_automated_follow_up BOOLEAN DEFAULT FALSE,is_forwarded BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ);",
   "INSERT INTO contacts(id) SELECT n FROM generate_series(1,9) n;",
   "INSERT INTO leads(id,contact_id) VALUES(50,5);",
  ].join("\n"));
  const message=async(id,contactId,role,content,minuteAgo,{staff=false,forwarded=false,delivery="sent"}={})=>{
   await db.query(
    "INSERT INTO messages(id,contact_id,role,content,sent_by_username,whatsapp_message_id,delivery_status,is_forwarded,created_at) "+
    "VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()-$9::int*INTERVAL '1 minute')",
    [id,contactId,role,content,staff?"admin":null,"wamid."+id,delivery,forwarded,minuteAgo]
   );
  };
  const convo=async(c,user,staff,next,opts={})=>{
    await message(c*100+1,c,"user",user,20);
    await message(c*100+2,c,"assistant",staff,10,{staff:true,...opts});
    await message(c*100+3,c,"user",next,9);
  };
  const query=(appointmentOnly)=>
   "SELECT "+temporaryStaffConversationSql("c","inbound",{appointmentOnly})+
   " AS held FROM contacts c JOIN messages inbound ON inbound.contact_id=c.id "+
   "WHERE c.id=$1 AND inbound.id=$2 AND inbound.role='user'";
  const check=async(c,id=c*100+3,appointmentOnly=true)=>
   (await db.query(query(appointmentOnly),[c,id])).rows[0].held;

  await convo(1,"i ask previously",
   "Regarding facial care: 3D 小颜术 is manual; 9D 逆龄抗衰 is device-based. Which interests you?","how much");
  assert.equal(await check(1),false,"staff facial menu must not silence AI");

  await convo(2,"Can I book an appointment?","Can you come tomorrow at 3pm?","Yes");
  assert.equal(await check(2),true,"staff time offer after booking enquiry is held");

  await convo(3,"我想预约","周六下午3点可以吗？","可以");
  assert.equal(await check(3),true,"Chinese natural slot proposal is held");

  await convo(4,"Can I book an appointment?","Tomorrow 3pm?","yes");
  assert.equal(await check(4),true,"terse slot proposal is protected");
  await message(404,4,"user","I want to know about 9D instead",8);
  assert.equal(await check(4,404),false,"explicit new 9D topic releases direct AI");
  await message(405,4,"user","Can I book 9D on Sunday instead?",7);
  assert.equal(await check(4,405),true,"booking intent involving 9D stays with staff");

  await convo(5,"Hi","See you soon","ok");
  await db.query("INSERT INTO lead_activities(lead_id,metadata) VALUES(50,$1::jsonb)",[
   JSON.stringify({outcome:"staff_appointment_reminder",staffMessageId:"502"})
  ]);
  assert.equal(await check(5),true,"verified reminder remains held");
  await message(504,5,"user","Which device is used for 9D?",8);
  assert.equal(await check(5,504),false,"unrelated device enquiry releases direct AI");
  assert.equal(await check(5,504,false),true,"verified reminder still suppresses marketing follow-ups");
  await message(505,5,"user","ok",7);
  assert.equal(await check(5,505),true,"reminder holds ambiguous appointment acknowledgement");

  await convo(6,"Can I book an appointment?","Tomorrow 3pm?","yes",{forwarded:true});
  assert.equal(await check(6),false,"forwarded messages never claim a staff conversation");

  await convo(7,"What is 9D?","Tomorrow 3pm?","yes");
  assert.equal(await check(7),false,"unrelated treatment enquiry is not a booking request");

  await convo(8,"Can I book an appointment?","Tomorrow 3pm?","I want the price of 3D");
  assert.equal(await check(8),false,"named treatment price question exits booking hold");

  await convo(9,"Can I book an appointment?","Tomorrow 3pm?","yes",{delivery:"failed"});
  assert.equal(await check(9),false,"failed staff sends never claim a conversation");
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  if(created)await db.query('DROP SCHEMA "'+schema+'" CASCADE').catch(()=>{});
  await db.end();
 }
});
