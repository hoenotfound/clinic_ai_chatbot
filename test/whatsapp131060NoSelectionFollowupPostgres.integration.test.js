"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const worker=require("../src/services/whatsappSecondaryFollowUpService");

const cs=process.env.TEST_DATABASE_URL;
test("migrated PostgreSQL permits neutral 131060 no-selection follow-ups only after accepted recovery and stops on reply or takeover",{
 skip:!cs
},async()=>{
 // Use a fixed logical daytime clock for this integration fixture. Real
 // GitHub CI may run at 00:00-07:00 MYT when sends must be suppressed.
 const local=new Date(Date.now()+8*3600000);
 local.setUTCHours(14,0,0,0);
 const fixtureNow=new Date(local.getTime()-8*3600000);
 const db=new Client({connectionString:cs});
 const schema="neutro_131060_silent_"+process.pid+"_"+Date.now();
 await db.connect();
 try{
  await db.query("CREATE SCHEMA "+schema);
  await db.query("SET search_path TO "+schema);
  const migrator={async connect(){
   const c=new Client({connectionString:cs});
   await c.connect();
   await c.query("SET search_path TO "+schema);
   return{query:(...args)=>c.query(...args),release:()=>c.end()};
  }};
  await runMigrations(migrator,{quiet:true});
  // Test-schema clock shadowing is isolated and never touches production.
  // Putting pg_catalog explicitly AFTER this schema lets now() resolve to the
  // fixture clock in sender SQL, while other built-in functions stay usable.
  await db.query("CREATE FUNCTION "+schema+".now() RETURNS timestamptz "+
    "LANGUAGE SQL STABLE AS 'SELECT ''"+fixtureNow.toISOString()+"''::timestamptz'");
  await db.query("SET search_path TO "+schema+", pg_catalog");
  assert.equal((await db.query("SELECT now() AS value")).rows[0].value.toISOString(),
    fixtureNow.toISOString());

  const senderName="neutro_secondary",phoneId="100000000001060",waba="200000000001060";
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES($1,$2,$3,'Secondary Test','active') RETURNING id",
    [senderName,phoneId,waba])).rows[0].id;
  await db.query(
    "INSERT INTO whatsapp_sender_followup_rules(sender_id,slot_hours,enabled,message_text) "+
    "VALUES($1,2,TRUE,'Do not send this generic text')",[sender]);

  const contact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
    "VALUES('whatsapp','60122201060',$1,NOW()-INTERVAL '2 years') RETURNING id",
    [sender])).rows[0].id;
  const conversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
    "VALUES($1,$2,'60122201060','bound') RETURNING id",
    [sender,contact])).rows[0].id;
  const inbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','📎 [Customer sent a WhatsApp message that could not be displayed]',"+
    " 'wamid.131060-silent',NOW()-INTERVAL '3 hours',NOW()-INTERVAL '3 hours') RETURNING id",
    [contact])).rows[0].id;
  await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [inbound,conversation]);

  const activation=new Date(fixtureNow.getTime()-25*3600000).toISOString();
  const audienceActivation=new Date(fixtureNow.getTime()-7*3600000).toISOString();
  const params=[senderName,phoneId,waba,fixtureNow,10,activation,"all_contacts",
    audienceActivation,activation];
  const candidates=async()=> (await db.query(worker.CANDIDATES_SQL,params)).rows;
  assert.equal((await candidates()).length,0,
    "unreadable 131060 alone cannot schedule reminders");

  const menu=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,delivery_status) "+
    "VALUES($1,'assistant',$2,'wamid.131060-menu',NOW()-INTERVAL '2 hours 58 minutes','pending') RETURNING id",
    [contact,"Hi～欢迎来到 Neutro Sense 😊\n想了解哪方面的护理呢？\n可以点下面的选项"]
  )).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [menu,conversation]);
  assert.equal((await candidates()).length,0,"a menu without accepted provider evidence is not enough");
  await db.query(
    "INSERT INTO outbound_message_evidence(message_id,contact_id,channel,origin,accepted,provider_message_id,accepted_at) "+
    "VALUES($1,$2,'whatsapp','system_fallback',TRUE,'wamid.131060-menu',NOW()-INTERVAL '2 hours 58 minutes')",
    [menu,contact]);
  assert.equal((await candidates()).length,0,
    "Meta API acceptance alone cannot authorize follow-up while delivery remains pending");
  await db.query("UPDATE messages SET delivery_status='delivered' WHERE id=$1",[menu]);
  const ready=await candidates();
  assert.equal(ready.length,1,"delivered recovery menu activates the 2h silent service slot");
  assert.equal(ready[0].recovery_no_selection,true);
  assert.equal(Number(ready[0].slot_hours),2);

  // A later staff explanation does not erase the recovered service session.
  // The customer can remain silent without explicitly choosing a treatment.
  const staff=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,sent_by_username,delivery_status) "+
    "VALUES($1,'assistant',$2,'wamid.131060-staff',NOW()-INTERVAL '2 hours 45 minutes',"+
    " 'WhatsApp Business App','delivered') RETURNING id",
    [contact,"我们这里有不同的护理，可以先了解您的情况。"]
  )).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [staff,conversation]);
  const afterStaff=await candidates();
  assert.equal(afterStaff.length,1,"a sender-verified staff explanation keeps neutral follow-up eligible");
  assert.equal(afterStaff[0].recovery_no_selection,true);
  assert.equal(afterStaff[0].staff_reply,false,
    "ordinary staff explanations preserve the original AI recovery anchor");
  assert.match(afterStaff[0].first_reply_text,/Hi～欢迎来到 Neutro Sense/);

  await db.query("UPDATE messages SET content=$2 WHERE id=$1",
    [staff,"请问您想了解哪方面的护理呢？"]);
  const afterStaffQuestion=await candidates();
  assert.equal(afterStaffQuestion.length,1,
    "an ordinary staff question does not cancel a verified 131060 recovery slot");
  assert.equal(afterStaffQuestion[0].staff_question,true);
  assert.equal(afterStaffQuestion[0].recovery_no_selection,true);

  // A second unreadable event has no new treatment intent; the initial
  // accepted menu is still the only safe reminder anchor.
  const repeat=(await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','📎 [Customer sent a WhatsApp message that could not be displayed]',"+
    " 'wamid.131060-repeat',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour') RETURNING id",
    [contact])).rows[0].id;
  await db.query("INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [repeat,conversation]);
  const repeatedCandidates=await candidates();
  assert.equal(repeatedCandidates.length,1,"another unreadable event must not kill the original recovery reminder");
  assert.equal(Number(repeatedCandidates[0].inbound_id),Number(inbound),
    "the reminder remains tied to the first provider-accepted recovery session");

  const claimed=(await db.query(
    "INSERT INTO whatsapp_sender_followup_attempts(sender_id,contact_id,anchor_message_id,slot_hours) "+
    "VALUES($1,$2,$3,2) RETURNING id",[sender,contact,inbound])).rows[0].id;
  const recheck=()=>db.query(worker.RECHECK_SQL,[
    contact,inbound,2,senderName,phoneId,waba,
    ready[0].rule_version,activation,"all_contacts",
    audienceActivation,activation]);
  assert.equal((await recheck()).rows[0].allowed,true,
    "the final pre-send check authorizes the same accepted recovery proof");
  await db.query("UPDATE messages SET delivery_status='failed' WHERE id=$1",[menu]);
  assert.equal((await recheck()).rows[0].allowed,false,
    "a later definitive delivery failure cancels the pending reminder");
  await db.query("UPDATE messages SET delivery_status='delivered' WHERE id=$1",[menu]);
  assert.equal((await recheck()).rows[0].allowed,true);

  await db.query(
    "UPDATE contacts SET whatsapp_opt_out_at=NOW() WHERE id=$1",[contact]);
  assert.equal((await recheck()).rows[0].allowed,false,"opt-out blocks pre-send");
  await db.query("UPDATE contacts SET whatsapp_opt_out_at=NULL WHERE id=$1",[contact]);

  await db.query(
    "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
    "VALUES($1,'user','3D 小颜术','wamid.131060-choice',NOW(),NOW())",[contact]);
  assert.equal((await recheck()).rows[0].allowed,false,
    "a customer reply cancels the old no-selection reminder");
  await db.query("DELETE FROM whatsapp_sender_followup_attempts WHERE id=$1",[claimed]);

  // All three stages must remain due against the ORIGINAL delivered recovery
  // menu, even when staff ask an ordinary question just before the worker runs.
  // Prior stages are explicitly accepted for later-stage fixtures.
  await db.query(
    "INSERT INTO whatsapp_sender_followup_rules(sender_id,slot_hours,enabled,message_text) "+
    "VALUES($1,6,TRUE,'Do not send this generic text'),($1,20,TRUE,'Do not send this generic text')",[sender]);
  for(const slot of [2,6,20]){
    const hoursAgo=slot+1;
    const customerWa="60122201"+String(600+slot);
    const c=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
      "VALUES('whatsapp',$1,$2,NOW()-INTERVAL '2 years') RETURNING id",
      [customerWa,sender])).rows[0].id;
    const sc=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
      "VALUES($1,$2,$3,'bound') RETURNING id",
      [sender,c,customerWa])).rows[0].id;
    const anchor=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
      "VALUES($1,'user','📎 [Customer sent a WhatsApp message that could not be displayed]',"+
      " $2,NOW()-$3::int*INTERVAL '1 hour',NOW()-$3::int*INTERVAL '1 hour') RETURNING id",
      [c,"wamid.recovery-timeline-"+slot,hoursAgo])).rows[0].id;
    const verifiedMenu=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,delivery_status) "+
      "VALUES($1,'assistant',$2,$3,NOW()-$4::int*INTERVAL '1 hour'+INTERVAL '2 minutes','delivered') RETURNING id",
      [c,"Hi～欢迎来到 Neutro Sense 😊\n可以点下面的选项",
        "wamid.recovery-timeline-menu-"+slot,hoursAgo])).rows[0].id;
    const human=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,sent_by_username,delivery_status) "+
      "VALUES($1,'assistant','请问您想了解哪方面的护理呢？',$2,NOW()-INTERVAL '15 minutes',"+
      " 'WhatsApp Business App','delivered') RETURNING id",
      [c,"wamid.recovery-timeline-staff-"+slot])).rows[0].id;
    for(const id of [anchor,verifiedMenu,human]){
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [id,sc]);
    }
    await db.query(
      "INSERT INTO outbound_message_evidence(message_id,contact_id,channel,origin,accepted,provider_message_id,accepted_at) "+
      "VALUES($1,$2,'whatsapp','system_fallback',TRUE,$3,NOW()-$4::int*INTERVAL '1 hour'+INTERVAL '2 minutes')",
      [verifiedMenu,c,"wamid.recovery-timeline-menu-"+slot,hoursAgo]);
    for(const previousSlot of [2,6].filter(p=>p<slot)){
      await db.query(
        "INSERT INTO whatsapp_sender_followup_attempts "+
        "(sender_id,contact_id,anchor_message_id,slot_hours,status,completed_at) "+
        "VALUES($1,$2,$3,$4,'accepted',NOW()-$5::int*INTERVAL '1 hour'"+
        "+$6::int*INTERVAL '1 minute')",
        [sender,c,anchor,previousSlot,hoursAgo,previousSlot*60+5]);
    }
    const live=(await candidates()).filter(item=>Number(item.contact_id)===Number(c));
    assert.equal(live.length,1,"staff question must not delay verified "+slot+"h recovery");
    assert.equal(Number(live[0].slot_hours),slot);
    assert.equal(live[0].recovery_no_selection,true);
    assert.equal(live[0].staff_question,true);
    const reservation=(await db.query(
      "INSERT INTO whatsapp_sender_followup_attempts(sender_id,contact_id,anchor_message_id,slot_hours) "+
      "VALUES($1,$2,$3,$4) RETURNING id",[sender,c,anchor,slot])).rows[0].id;
    const check=async()=> (await db.query(worker.RECHECK_SQL,[
      c,anchor,slot,senderName,phoneId,waba,live[0].rule_version,
      activation,"all_contacts",audienceActivation,
      activation])).rows[0].allowed;
    assert.equal(await check(),true,"provider recheck permits silent "+slot+"h recovery");
    await db.query("UPDATE messages SET delivery_status='failed' WHERE id=$1",[verifiedMenu]);
    assert.equal(await check(),false,"failed menu must block "+slot+"h send");
    await db.query("UPDATE messages SET delivery_status='delivered' WHERE id=$1",[verifiedMenu]);
    await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[c]);
    assert.equal(await check(),false,"staff takeover must block "+slot+"h send");
    await db.query("UPDATE contacts SET mode='ai' WHERE id=$1",[c]);
    await db.query("UPDATE contacts SET whatsapp_opt_out_at=NOW() WHERE id=$1",[c]);
    assert.equal(await check(),false,"opt-out must block "+slot+"h send");
    await db.query("UPDATE contacts SET whatsapp_opt_out_at=NULL WHERE id=$1",[c]);
    assert.equal(await check(),true);
    if(slot===20){
      const lead=(await db.query(
        "INSERT INTO leads(contact_id,created_by) VALUES($1,'Automation') RETURNING id",
        [c])).rows[0].id;
      await db.query("UPDATE leads SET appointment_status='booked' WHERE id=$1",[lead]);
      assert.equal(await check(),false,"confirmed booking must stop 20h recovery");
      await db.query("UPDATE leads SET appointment_status='none' WHERE id=$1",[lead]);
      assert.equal(await check(),true);
    }
    await db.query("DELETE FROM whatsapp_sender_followup_attempts WHERE id=$1",[reservation]);
  }

 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
