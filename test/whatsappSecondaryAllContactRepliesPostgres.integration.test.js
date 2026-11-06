"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {Client} = require("pg");
const {runMigrations} = require("../src/db/migrationRunner");
const {
  secondaryAllContactReplyActivation, isSecondaryAiReplyEligible,
  eligibleSecondaryAiReplyContactIds, isSecondaryAdsOnlyEligible,
} = require("../src/services/whatsappSecondaryAdsOnlyEligibility");

const cs = process.env.TEST_DATABASE_URL;
test("secondary all-contact AI replies accept only post-switch inbound on the correct sender; existing history is fine", {skip:!cs}, async()=>{
  const db = new Client({connectionString:cs});
  const schema="secondary_all_contact_reply_"+process.pid+"_"+Date.now();
  await db.connect();
  try {
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const migrator={async connect(){
      const client=new Client({connectionString:cs});
      await client.connect();
      await client.query("SET search_path TO "+schema);
      return {query:(...args)=>client.query(...args),release:()=>client.end()};
    }};
    await runMigrations(migrator,{quiet:true});
    const phoneId="100000000000012",accountId="200000000000012";
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
      "VALUES('neutro_secondary',$1,$2,'Test Secondary','active') RETURNING id",
      [phoneId,accountId])).rows[0].id;
    const cutoff=new Date(Date.now()-300000).toISOString();
    const env={
      WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
      WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:cutoff,
      WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
      WHATSAPP_SECONDARY_PHONE_NUMBER_ID:phoneId,
      WHATSAPP_SECONDARY_WABA_ID:accountId,
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
      WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:cutoff,
    };
    assert.equal(secondaryAllContactReplyActivation(env),new Date(cutoff).toISOString());
    let seq=0;
    async function createContact(){
      seq++;
      const phone="601247"+String(seq).padStart(6,"0");
      const id=(await db.query(
        "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
        "VALUES('whatsapp',$1,$2,NOW()-INTERVAL '1 year') RETURNING id",
        [phone,sender])).rows[0].id;
      const conv=(await db.query(
        "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
        "VALUES($1,$2,$3,'bound') RETURNING id",[sender,id,phone])).rows[0].id;
      return {id,conv,phone};
    }
    async function inbound(c,when){
      seq++;
      const id=(await db.query(
        "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
        "VALUES($1,'user','Hello',$2,$3::timestamptz,$3::timestamptz) RETURNING id",
        [c.id,"wamid.secondary-all-reply-"+seq,when])).rows[0].id;
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [id,c.conv]);
      return id;
    }
    const historical=await createContact();
    await db.query("UPDATE contacts SET whatsapp_coexistence_imported_at=NOW() WHERE id=$1",
      [historical.id]);
    const old=await inbound(historical,new Date(Date.now()-24*3600*1000).toISOString());
    // A historical conversation on the primary number is now explicitly allowed
    // for a future customer-initiated reply on secondary, not marketing.
    await db.query(
      "INSERT INTO contacts(channel,whatsapp_number,created_at) "+
      "VALUES('whatsapp',$1,NOW()-INTERVAL '2 years')",
      [historical.phone]);
    const newMessage=await inbound(historical,new Date().toISOString());
    assert.equal(await isSecondaryAdsOnlyEligible(historical.id,{database:db,env}),false);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:old}),false,"old inbound cannot replay");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),true,
      "old imported and primary history no longer excludes a new direct enquiry");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{database:db,env}),true);
    assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([historical.id,0,-1],{
      database:db,env})],[historical.id]);

    // #8946: an informational Meta 131060 placeholder must not silence the
    // customer's next readable message. The review remains pending for staff.
    const unavailable=(await db.query(
      "INSERT INTO ai_review_items(contact_id,inbound_message_id,category,summary,status) "+
      "VALUES($1,$2,'information','WhatsApp message unavailable (Meta 131060). Meta did not provide the content.','pending') RETURNING id",
      [historical.id,old])).rows[0].id;
    await db.query(
      "UPDATE contacts SET needs_attention=TRUE, attention_reason=$2 WHERE id=$1",
      [historical.id,"AI review requested: [#"+old+"] WhatsApp message unavailable (Meta 131060)"]
    );
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),true,
      "an informational 131060 review does not suppress a new valid AI reply");
    assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([historical.id],{
      database:db,env})],[historical.id],"Inbox must agree with per-message eligibility");
    assert.equal((await db.query(
      "SELECT status FROM ai_review_items WHERE id=$1",[unavailable])).rows[0].status,
      "pending","the unreadable message still requires staff attention");

    await db.query("UPDATE ai_review_items SET category='clinical' WHERE id=$1",[unavailable]);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),false,
      "clinical reviews always block secondary replies");
    await db.query("UPDATE ai_review_items SET category='information',summary='Other administrative review' WHERE id=$1",[unavailable]);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),false,
      "unrelated informational reviews do not bypass staff holds");
    await db.query("UPDATE ai_review_items SET summary='WhatsApp message unavailable (Meta 131060)' WHERE id=$1",[unavailable]);
    await db.query("UPDATE contacts SET attention_reason='Delivery failed: Meta refused send' WHERE id=$1",[historical.id]);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),false,
      "delivery and other more serious attention reasons still block");
    await db.query("UPDATE contacts SET needs_attention=FALSE,attention_reason=NULL WHERE id=$1",[historical.id]);
    await db.query("UPDATE ai_review_items SET status='resolved' WHERE id=$1",[unavailable]);

    await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[historical.id]);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),false,"staff takeover stays manual");
    await db.query("UPDATE contacts SET mode='ai',needs_attention=TRUE WHERE id=$1",
      [historical.id]);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),false,"staff attention blocks AI");
    await db.query("UPDATE contacts SET needs_attention=FALSE,whatsapp_opt_out_at=NOW() WHERE id=$1",
      [historical.id]);
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env,inboundMessageId:newMessage}),false,"opt-out blocks AI");
    await db.query("UPDATE contacts SET whatsapp_opt_out_at=NULL WHERE id=$1",[historical.id]);

    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env:{...env,WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"wrong"},
      inboundMessageId:newMessage}),false,"incorrect secondary phone ID blocks AI");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env:{...env,WHATSAPP_SECONDARY_WABA_ID:"wrong"},
      inboundMessageId:newMessage}),false,"incorrect secondary WABA blocks AI");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env:{...env,WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"not-a-date"},
      inboundMessageId:newMessage}),false,"invalid activation fails closed");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env:{...env,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false"},
      inboundMessageId:newMessage}),false,"disabled AI cannot query eligibility");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env:{...env,WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:new Date(Date.now()+60000).toISOString()},
      inboundMessageId:newMessage}),false,"future activation rejects pre-activation inbound");
    assert.equal(await isSecondaryAiReplyEligible(historical.id,{
      database:db,env:{...env,WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"ads_only"},
      inboundMessageId:newMessage}),false,"ads-only mode still rejects known history");

    const unbound=await createContact();
    await db.query("DELETE FROM whatsapp_sender_conversations WHERE id=$1",[unbound.conv]);
    assert.equal(await isSecondaryAiReplyEligible(unbound.id,{database:db,env}),false,
      "missing bound conversation blocks secondary sends");
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
