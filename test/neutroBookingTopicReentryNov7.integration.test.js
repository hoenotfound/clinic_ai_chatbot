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
   "INSERT INTO contacts(id) SELECT n FROM generate_series(1,22) n;",
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
  await message(406,4,"user","9D",6);
  assert.equal(await check(4,406),true,"bare 9D is a booking treatment selection, not a new enquiry");
  await message(407,4,"user","3D please",5);
  assert.equal(await check(4,407),true,"brief treatment selection must not interrupt a booking");
  await message(408,4,"user","What is the 9D treatment time?",4);
  assert.equal(await check(4,408),false,"specific treatment information question is a new topic");

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

  await convo(10,"Boleh saya buat temujanji?","Boleh datang esok pukul 3 petang?","boleh");
  assert.equal(await check(10),true,"Malay natural day/time proposal keeps the booking with staff");

  await convo(11,"Can I book a visit?","Tomorrow at 3?","yes");
  assert.equal(await check(11),true,"English time without AM/PM is still a booking conversation");
  // A calendar date and time in a staff message are not sufficient evidence
  // of a booking. The customer must have an actual staff slot proposal.
  await convo(12,"Can I book an appointment?","The promo offer ends tomorrow at 3pm","yes");
  assert.equal(await check(12),false,"promo expiry must not become a booking hold");
  await convo(13,"Can I book an appointment?","The clinic closes tomorrow at 3pm","yes");
  assert.equal(await check(13),false,"closing hours must not become a booking hold");
  await convo(14,"Can I book an appointment?","Please call me tomorrow at 3pm","yes");
  assert.equal(await check(14),false,"callback arrangements must not become a visit booking");
  await convo(15,"Can I book an appointment?","3D appointment promo ends tomorrow at 3pm","yes");
  assert.equal(await check(15),false,"the word appointment in a promotion must not claim booking ownership");

  // Booking-specific new questions stay with staff even when a treatment name
  // and a general information/question word also appear in the same message.
  await convo(16,"Can I book an appointment?","Your appointment is tomorrow at 3pm","How much is the deposit for 9D?");
  assert.equal(await check(16),true,"9D deposit question belongs to existing booking");
  await convo(17,"Can I book an appointment?","Your appointment is tomorrow at 3pm","What time is my 9D session?");
  assert.equal(await check(17),true,"my booked 9D session time must remain staff-owned");
  await convo(18,"Can I book an appointment?","Your appointment is tomorrow at 3pm","What is the 9D treatment duration?");
  assert.equal(await check(18),false,"procedure duration is an independent treatment question");
  await convo(19,"Can I book an appointment?","Your appointment is tomorrow at 3pm","Which device is used for 9D?");
  assert.equal(await check(19),false,"device specifications are unrelated to the booking");
  await convo(20,"Can I book an appointment?","Your appointment is tomorrow at 3pm","Is 9D safe if I am pregnant?");
  assert.equal(await check(20),true,"SQL holds the booking, but server must exempt clinical safety risk");
  await convo(21,"Can I book an appointment?","Tomorrow at 3?","How much is the booking fee for 9D?");
  assert.equal(await check(21),true,"booking fee must remain staff-owned");
  await convo(22,"Can I book an appointment?","Tomorrow at 3?","How much is 9D First Trial?");
  assert.equal(await check(22),false,"unrelated verified treatment-price question can proceed");

 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  if(created)await db.query('DROP SCHEMA "'+schema+'" CASCADE').catch(()=>{});
  await db.end();
 }
});
