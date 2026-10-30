"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const {isSecondaryAdsOnlyEligible}=require("../src/services/whatsappSecondaryAdsOnlyEligibility");

const cs=process.env.TEST_DATABASE_URL;
test("PostgreSQL admits only new first-click ad contacts; imported, direct and old chats remain manual",
 {skip:!cs},async()=>{
  const db=new Client({connectionString:cs});
  const schema="secondary_ad_audience_"+process.pid+"_"+Date.now();
  await db.connect();
  try{
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const pool={async connect(){
      const c=new Client({connectionString:cs});
      await c.connect();
      await c.query("SET search_path TO "+schema);
      return {query:(...args)=>c.query(...args),release:()=>c.end()};
    }};
    await runMigrations(pool,{quiet:true});
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
      "VALUES('neutro_secondary','100000000000002','200000000000002','Neutro Secondary','active') RETURNING id"
    )).rows[0].id;
    const cutoff=new Date(Date.now()-60*1000).toISOString();
    const env={
      WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
      WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
      WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:cutoff,
    };
    let n=0;
    async function createContact({old=false}={}){
      n++;
      const phone="6012300"+String(n).padStart(5,"0");
      const row=(await db.query(
        "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
        "VALUES('whatsapp',$1,$2,$3::timestamptz) RETURNING id",
        [phone,sender,old?new Date(Date.now()-24*3600*1000).toISOString():new Date().toISOString()]
      )).rows[0];
      const conv=(await db.query(
        "INSERT INTO whatsapp_sender_conversations(sender_id,customer_wa_id,contact_id,state) "+
        "VALUES($1,$2,$3,'bound') RETURNING id",[sender,phone,row.id]
      )).rows[0].id;
      return {id:row.id,conv};
    }
    async function inbound(contact,{ad=false,imported=false,sourceTime=new Date().toISOString()}={}){
      n++;
      const m=(await db.query(
        "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,source_created_at) "+
        "VALUES($1,'user','Hi',$2,$3::timestamptz) RETURNING id",
        [contact.id,"wamid.secondary-ads-only-"+n,sourceTime]
      )).rows[0].id;
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [m,contact.conv]
      );
      if(ad)await db.query(
        "INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,meta_ad_id,source_type) VALUES($1,$2,$3,'ad')",
        [m,contact.id,"verified-ad-"+m]
      );
      if(imported)await db.query(
        "INSERT INTO whatsapp_sender_coexistence_history_messages(message_id,sender_id,source_wamid_hash) VALUES($1,$2,$3)",
        [m,sender,"a".repeat(63)+String(n%10)]
      );
      return m;
    }
    const qualify=id=>isSecondaryAdsOnlyEligible(id,{database:db,env});
    const newAd=await createContact(); await inbound(newAd,{ad:true});
    assert.equal(await qualify(newAd.id),true,"new first message verified Meta ad qualifies");
    const direct=await createContact(); await inbound(direct);
    assert.equal(await qualify(direct.id),false,"new direct message remains manual");
    await inbound(direct,{ad:true});
    assert.equal(await qualify(direct.id),false,"later ad must not upgrade a direct chat");
    const history=await createContact(); await inbound(history,{ad:true,imported:true});
    assert.equal(await qualify(history.id),false,"imported history must never qualify");
    const contactOnly=await createContact();
    await db.query("UPDATE contacts SET whatsapp_coexistence_imported_at=NOW() WHERE id=$1",[contactOnly.id]);
    await inbound(contactOnly,{ad:true});
    assert.equal(await qualify(contactOnly.id),false,"contact-only Business App import stays manual");
    const delayed=await createContact();
    await inbound(delayed,{ad:true,sourceTime:new Date(Date.now()-86400000).toISOString()});
    assert.equal(await qualify(delayed.id),false,"old provider timestamp cannot become fresh ad");
    const oldContact=await createContact({old:true}); await inbound(oldContact,{ad:true});
    assert.equal(await qualify(oldContact.id),false,"old contact must remain manual even on a new ad click");
    const missing=await createContact();await inbound(missing);
    assert.equal(await qualify(missing.id),false,"unknown first source fails closed");
    assert.equal(await isSecondaryAdsOnlyEligible(newAd.id,{database:db,env:{
      ...env,WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"off"
    }}),false,"disabled audience never qualifies");
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
