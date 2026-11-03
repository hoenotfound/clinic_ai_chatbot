"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const worker=require("../src/services/whatsappSecondaryFollowUpService");

const cs=process.env.TEST_DATABASE_URL;
test("secondary 2h service follow-up matches primary for new initiated chats, not marketing templates",{
  skip:!cs,
},async()=>{
  const db=new Client({connectionString:cs});
  const schema="neutro_fu_parity_"+process.pid+"_"+Date.now();
  await db.connect();
  try{
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const migrator={async connect(){
      const conn=new Client({connectionString:cs});
      await conn.connect();
      await conn.query("SET search_path TO "+schema);
      return {query:(...args)=>conn.query(...args),release:()=>conn.end()};
    }};
    await runMigrations(migrator,{quiet:true});

    const senderName="neutro_secondary",phoneId="100000000000033",waba="200000000000033";
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
      "VALUES($1,$2,$3,'Secondary Test','active') RETURNING id",
      [senderName,phoneId,waba])).rows[0].id;
    await db.query(
      "INSERT INTO whatsapp_sender_followup_rules(sender_id,slot_hours,enabled,message_text) "+
      "VALUES($1,2,TRUE,'Service reminder')",[sender]);

    const phone="60122200033";
    const contact=(await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
      "VALUES('whatsapp',$1,$2,$3::timestamptz) RETURNING id",
      [phone,sender,"2026-10-01T00:00:00Z"])).rows[0].id;
    const conversation=(await db.query(
      "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
      "VALUES($1,$2,$3,'bound') RETURNING id",
      [sender,contact,phone])).rows[0].id;

    const simulatedNow="2026-11-03T06:00:00Z"; // 14:00 MYT
    const customerAt="2026-11-03T03:40:00Z";
    const replyAt="2026-11-03T03:43:00Z";
    const inbound=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
      "VALUES($1,'user','Please explain the treatment',$2,$3::timestamptz,$3::timestamptz) RETURNING id",
      [contact,"wamid.secondary-parity-inbound",customerAt])).rows[0].id;
    const reply=(await db.query(
      "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
      "VALUES($1,'assistant','I can explain the treatment',$2,$3::timestamptz,$3::timestamptz) RETURNING id",
      [contact,"wamid.secondary-parity-reply",replyAt])).rows[0].id;
    for(const id of [inbound,reply])await db.query(
      "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
      [id,conversation]);
    const base=[senderName,phoneId,waba,new Date(simulatedNow),10,
      "2026-11-03T02:30:00Z","all_contacts","2026-10-20T00:00:00Z"];
    const eligible=async cutoff=>(await db.query(worker.CANDIDATES_SQL,[...base,cutoff])).rows;

    assert.equal((await eligible(null)).length,0,
      "opt-in-only legacy mode must remain unchanged without the new cutoff");
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,1,
      "a real new service enquiry does not need separate marketing consent");
    assert.equal((await eligible("2026-11-03T03:42:00Z")).length,0,
      "an enquiry before activation cannot be replayed as a new follow-up");
    await db.query("UPDATE contacts SET whatsapp_opt_out_at=NOW() WHERE id=$1",[contact]);
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,0,
      "STOP blocks normal service follow-ups");
    await db.query("UPDATE contacts SET whatsapp_opt_out_at=NULL,whatsapp_marketing_opt_out_at=NOW() WHERE id=$1",[contact]);
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,0,
      "marketing-only STOP still blocks configured 2h/6h/20h outreach");
    await db.query("UPDATE contacts SET whatsapp_marketing_opt_out_at=NULL WHERE id=$1",[contact]);

    const lead=(await db.query(
      "INSERT INTO leads(contact_id,marketing_consent) VALUES($1,'opted_out') RETURNING id",
      [contact])).rows[0].id;
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,0,
      "a negative latest-lead consent decision cannot be overridden");
    await db.query("UPDATE leads SET marketing_consent='unknown' WHERE id=$1",[lead]);
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,1,
      "ordinary new service enquiry with unknown marketing status is eligible");
    await db.query("UPDATE leads SET appointment_status='set' WHERE id=$1",[lead]);
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,0,
      "confirmed booking blocks follow-up");
    await db.query("UPDATE leads SET appointment_status='none' WHERE id=$1",[lead]);
    await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[contact]);
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,0,
      "staff handoff blocks follow-up");
    await db.query("UPDATE contacts SET mode='ai',needs_attention=TRUE WHERE id=$1",[contact]);
    assert.equal((await eligible("2026-11-03T03:35:00Z")).length,0,
      "staff attention blocks follow-up");

    // Marketing templates deliberately keep a sender- and treatment-bound
    // explicit consent proof regardless of this service-follow-up change.
    const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
    assert.match(marketing.CANDIDATES_SQL,
      /whatsapp_marketing_consent_events consent/);
    assert.match(marketing.CANDIDATES_SQL,
      /consent\.consent_scope='treatment_followups_and_related_offers'/);
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
