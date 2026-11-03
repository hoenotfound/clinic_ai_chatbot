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
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
      WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:cutoff,
    };
    let n=0;
    async function createContact({old=false,phone:providedPhone=null}={}){
      n++;
      const phone=providedPhone || ("6012300"+String(n).padStart(5,"0"));
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
    // A previously known Neutro primary contact (both E.164 and the
    // legacy local 01x representation) must never be upgraded by a new
    // secondary-number CTWA click. Primary contacts remain untouched.
    for (const [suffix,primaryStored] of [
      ["89123","60123889123"],["89124","0123889124"]
    ]) {
      const secondaryPhone="601238"+suffix;
      await db.query(
        "INSERT INTO contacts(whatsapp_number,created_at) "+
        "VALUES($1,$2::timestamptz)",
        [primaryStored,new Date(Date.now()-86400000).toISOString()]
      );
      const knownPatient=await createContact({phone:secondaryPhone});
      await inbound(knownPatient,{ad:true});
      assert.equal(await qualify(knownPatient.id),false,
        "older primary-number patient remains manual even on first secondary ad click");
    }
    const direct=await createContact(); await inbound(direct);
    assert.equal(await qualify(direct.id),false,"new direct message remains manual");
    await inbound(direct,{ad:true});
    assert.equal(await qualify(direct.id),false,"later ad must not upgrade a direct chat");
    const history=await createContact(); await inbound(history,{ad:true,imported:true});
    assert.equal(await qualify(history.id),false,"imported history must never qualify");
    const contactOnly=await createContact({old:true});
    await db.query("UPDATE contacts SET whatsapp_coexistence_imported_at=NOW() WHERE id=$1",[contactOnly.id]);
    const contactOnlyFirstAd=await inbound(contactOnly,{ad:true});
    assert.equal(await qualify(contactOnly.id),false,
      "six-month contact sync alone cannot prove absence of older chats");
    // Staff checked the full Business App history on BOTH numbers and made
    // a named decision. Creating a review has no send/replay side effect.
    await db.query(
      "INSERT INTO whatsapp_secondary_ad_eligibility_reviews "+
      "(contact_id,origin_message_id,decision,reviewed_by,"+
      " secondary_app_history_checked,primary_app_history_checked,review_note) "+
      "VALUES($1,$2,'no_prior_conversation_verified',$3,TRUE,TRUE,$4)",
      [contactOnly.id,contactOnlyFirstAd,"reviewer","Full history checked on both numbers; no prior chat"]
    );
    assert.equal(await qualify(contactOnly.id),true,
      "staff-reviewed contact-only first CTWA lead may receive future AI replies");
    // Historical evidence discovered after approval always revokes eligibility.
    await inbound(contactOnly,{imported:true});
    assert.equal(await qualify(contactOnly.id),false,
      "review must never override an imported historical conversation");
    const delayed=await createContact();
    await inbound(delayed,{ad:true,sourceTime:new Date(Date.now()-86400000).toISOString()});
    assert.equal(await qualify(delayed.id),false,"old provider timestamp cannot become fresh ad");
    const oldContact=await createContact({old:true});
    const oldAdId=await inbound(oldContact,{ad:true});
    assert.equal(await qualify(oldContact.id),false,"old contact must remain manual until verified");
    await db.query(
      "INSERT INTO whatsapp_secondary_ad_eligibility_reviews "+
      "(contact_id,origin_message_id,decision,reviewed_by,"+
      " secondary_app_history_checked,primary_app_history_checked,review_note) "+
      "VALUES($1,$2,'historical_or_unknown',$3,FALSE,FALSE,$4)",
      [oldContact.id,oldAdId,"reviewer","Historical status remains unknown"]
    );
    assert.equal(await qualify(oldContact.id),false,"negative/unknown review cannot authorize AI");
    await db.query(
      "UPDATE whatsapp_secondary_ad_eligibility_reviews SET "+
      "decision='no_prior_conversation_verified',reviewed_by='reviewer',"+
      "secondary_app_history_checked=TRUE,primary_app_history_checked=TRUE,"+
      "review_note='Full Business App history verified on both numbers', reviewed_at=NOW() "+
      "WHERE contact_id=$1",[oldContact.id]
    );
    assert.equal(await qualify(oldContact.id),true,
      "verified contact with an old contact row but no historic chats can qualify");
    // A primary account row created after the ad can still contain an older
    // provider-dated historical conversation; it must revoke the review.
    const oldPhone=(await db.query(
      "SELECT whatsapp_number FROM contacts WHERE id=$1",[oldContact.id]
    )).rows[0].whatsapp_number;
    const primary=(await db.query(
      "INSERT INTO contacts(whatsapp_number,created_at) "+
      "VALUES($1,NOW()) RETURNING id",[oldPhone]
    )).rows[0];
    await db.query(
      "INSERT INTO messages(contact_id,role,content,source_created_at) "+
      "VALUES($1,'user','Old primary conversation',NOW()-INTERVAL '7 days')",
      [primary.id]
    );
    assert.equal(await qualify(oldContact.id),false,
      "late-imported historical primary conversation must override approval");
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
