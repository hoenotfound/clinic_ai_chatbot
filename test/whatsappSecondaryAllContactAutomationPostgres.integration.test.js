"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const {isSecondaryAutomationEligible,secondaryAutomationEligibleSql,
  isSecondaryAdsOnlyEligible,eligibleSecondaryAdsOnlyContactIds,
  secondaryAutomationAttentionAllowedSql}=
  require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const followup=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const media=require("../src/services/whatsappSecondaryAiMediaQueue");

const cs=process.env.TEST_DATABASE_URL;
test("Postgres: fresh non-ad messages qualify without replay; old ad sequences survive",{
  skip:!cs,
},async()=>{
  const db=new Client({connectionString:cs});
  const schema="secondary_all_automation_"+process.pid+"_"+Date.now();
  await db.connect();
  try{
    await db.query("CREATE SCHEMA "+schema);
    await db.query("SET search_path TO "+schema);
    const migrator={async connect(){
      const c=new Client({connectionString:cs});
      await c.connect();
      await c.query("SET search_path TO "+schema);
      return {query:(...args)=>c.query(...args),release:()=>c.end()};
    }};
    await runMigrations(migrator,{quiet:true});
    const sender=(await db.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
      "VALUES('neutro_secondary','100000000000023','200000000000023','Neutro','active') RETURNING id"
    )).rows[0].id;
    const now=Date.now();
    const legacy=new Date(now-2*86400000).toISOString();
    const replyAt=new Date(now-60000).toISOString();
    const cutover=new Date(now-30000).toISOString();
    const env={
      WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
      WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:legacy,
      WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
      WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:replyAt,
      WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:cutover,
    };
    let seq=0;
    async function contact(old=false){
      seq++;
      const phone="601755"+String(seq).padStart(6,"0");
      const id=(await db.query(
        "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id,created_at) "+
        "VALUES('whatsapp',$1,$2,$3::timestamptz) RETURNING id",[
          phone,sender,old?new Date(now-365*86400000).toISOString():
          new Date(now-50000).toISOString()
        ])).rows[0].id;
      const conversation=(await db.query(
        "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
        "VALUES($1,$2,$3,'bound') RETURNING id",[sender,id,phone])).rows[0].id;
      return {id,conversation,phone};
    }
    async function inbound(c,{at=new Date(now).toISOString(),ad=false,imported=false}={}){
      seq++;
      const id=(await db.query(
        "INSERT INTO messages(contact_id,role,content,whatsapp_message_id,created_at,source_created_at) "+
        "VALUES($1,'user','Interested',$2,$3::timestamptz,$3::timestamptz) RETURNING id",
        [c.id,"wamid.automation-"+seq,at])).rows[0].id;
      await db.query(
        "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
        [id,c.conversation]);
      if(ad)await db.query(
        "INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,meta_ad_id,source_type) "+
        "VALUES($1,$2,$3,'ad')",[id,c.id,"verified-ad-"+id]);
      if(imported)await db.query(
        "INSERT INTO whatsapp_sender_coexistence_history_messages(message_id,sender_id,source_wamid_hash) "+
        "VALUES($1,$2,$3)",[id,sender,"b".repeat(63)+String(seq%10)]);
      return id;
    }
    const direct=await contact(true);
    const historyMessage=await inbound(direct,{at:new Date(now-90*86400000).toISOString(),imported:true});
    const fresh=await inbound(direct);
    assert.equal(await isSecondaryAutomationEligible(direct.id,{
      database:db,env,inboundMessageId:historyMessage}),false,
      "imported history must not be sent to AI/media followup as fresh automation");
    assert.equal(await isSecondaryAutomationEligible(direct.id,{
      database:db,env,inboundMessageId:fresh}),true,
      "fresh direct incoming can enter future automation if separately consented");
    const previousPatient=await contact(true);
    await db.query("INSERT INTO contacts(whatsapp_number,channel,created_at) "+
      "VALUES($1,'whatsapp',$2::timestamptz)",
      [previousPatient.phone,new Date(now-700*86400000).toISOString()]);
    const formerPatientFresh=await inbound(previousPatient);
    assert.equal(await isSecondaryAutomationEligible(previousPatient.id,{
      database:db,env,inboundMessageId:formerPatientFresh}),true,
      "known primary patient may enter automation only on a new secondary incoming");
    const ad=await contact();
    const oldAdMessage=await inbound(ad,{
      at:new Date(now-42000).toISOString(),ad:true
    });
    assert.equal(await isSecondaryAutomationEligible(ad.id,{
      database:db,env,inboundMessageId:oldAdMessage}),true,
      "previously approved ad-origin contact retains its active followup sequence");

    // A new CTWA lead can start with a Meta 131060 placeholder that contains
    // no readable text. The immediately subsequent signed ad referral is the
    // first usable enquiry, not an old direct conversation.
    const unavailable=await contact();
    const unavailableAt=new Date(now-10000).toISOString();
    const placeholder=await inbound(unavailable,{at:unavailableAt});
    await db.query(
      "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) "+
      "VALUES($1,$2,'whatsapp',$3::jsonb,'completed')",
      [placeholder,unavailable.id,JSON.stringify({
        unsupportedType:"unsupported",unsupportedErrors:[{code:131060}],
      })]
    );
    const firstAd=await inbound(unavailable,{
      at:new Date(now-7000).toISOString(),ad:true,
    });
    const adOnly={...env,WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only"};
    assert.equal(await isSecondaryAdsOnlyEligible(unavailable.id,{database:db,env:adOnly}),true,
      "a single verified 131060 placeholder may precede the first real CTWA ad");
    assert.deepEqual([...await eligibleSecondaryAdsOnlyContactIds([unavailable.id],{
      database:db,env:adOnly})],[unavailable.id],
      "Inbox bulk ads-only eligibility agrees with the single-contact rule");
    await db.query(
      "INSERT INTO ai_review_items(contact_id,inbound_message_id,category,summary,status) "+
      "VALUES($1,$2,'information','WhatsApp message unavailable (Meta 131060). Meta did not provide the content.','pending')",
      [unavailable.id,placeholder]);
    await db.query(
      "UPDATE contacts SET needs_attention=TRUE,attention_reason='AI review requested: [Meta 131060]' WHERE id=$1",
      [unavailable.id]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),true,
      "a 131060-only informational review does not suppress the next eligible pictures and follow-ups");
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env,inboundMessageId:firstAd}),true,
      "all-contact automation eligibility shares the same narrow review exception");
    const permission=await db.query(
      "SELECT "+secondaryAutomationAttentionAllowedSql("c")+" AS allowed FROM contacts c WHERE id=$1",
      [unavailable.id]);
    assert.equal(permission.rows[0].allowed,true);
    await db.query(
      "UPDATE ai_review_items SET category='clinical' WHERE contact_id=$1 AND inbound_message_id=$2",
      [unavailable.id,placeholder]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),false,
      "a clinical review still blocks all secondary automation");
    await db.query(
      "UPDATE ai_review_items SET category='information',summary='Unrelated unresolved question' "+
      "WHERE contact_id=$1 AND inbound_message_id=$2",
      [unavailable.id,placeholder]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),false,
      "unrelated informational reviews must remain restrictive");
    await db.query(
      "UPDATE ai_review_items SET summary='WhatsApp message unavailable (Meta 131060)' "+
      "WHERE contact_id=$1 AND inbound_message_id=$2",
      [unavailable.id,placeholder]);
    await db.query("UPDATE contacts SET attention_reason='Delivery failed: not accepted' WHERE id=$1",
      [unavailable.id]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),false,
      "delivery failures still block all secondary automation");
    await db.query("UPDATE contacts SET attention_reason='Booking ready: pending staff' WHERE id=$1",
      [unavailable.id]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),false,
      "Booking ready is NOT an exception for pictures or follow-ups");
    await db.query("UPDATE contacts SET attention_reason='AI review requested: pending',mode='human' WHERE id=$1",
      [unavailable.id]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),false,
      "staff takeover cannot be bypassed by the review exception");
    await db.query("UPDATE contacts SET mode='ai',whatsapp_opt_out_at=NOW() WHERE id=$1",[unavailable.id]);
    assert.equal(await isSecondaryAutomationEligible(unavailable.id,{
      database:db,env:adOnly,inboundMessageId:firstAd}),false,
      "customer opt-out still blocks automation");

    // False positives: wrong Meta error or an additional earlier message
    // can never turn an old/direct conversation into an ad-first enquiry.
    const wrong=await contact();
    const wrongPlaceholder=await inbound(wrong,{at:new Date(now-9000).toISOString()});
    await db.query(
      "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) "+
      "VALUES($1,$2,'whatsapp',$3::jsonb,'completed')",
      [wrongPlaceholder,wrong.id,JSON.stringify({
        unsupportedType:"unsupported",unsupportedErrors:[{code:131051}],
      })]);
    await inbound(wrong,{at:new Date(now-6000).toISOString(),ad:true});
    assert.equal(await isSecondaryAdsOnlyEligible(wrong.id,{database:db,env:adOnly}),false,
      "other unsupported messages never establish first-ad eligibility");
    const olderConversation=await contact();
    const earlier=await inbound(olderConversation,{at:new Date(now-15000).toISOString()});
    await db.query(
      "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) "+
      "VALUES($1,$2,'whatsapp',$3::jsonb,'completed')",
      [earlier,olderConversation.id,JSON.stringify({
        unsupportedType:"unsupported",unsupportedErrors:[{code:131060}],
      })]);
    await inbound(olderConversation,{at:new Date(now-12000).toISOString()});
    await inbound(olderConversation,{at:new Date(now-9000).toISOString(),ad:true});
    assert.equal(await isSecondaryAdsOnlyEligible(olderConversation.id,{
      database:db,env:adOnly}),false,
      "an intervening real customer message remains evidence of prior conversation");
    const tooLate=await contact();
    await db.query("UPDATE contacts SET created_at=$2::timestamptz WHERE id=$1",
      [tooLate.id,new Date(now-5*60000).toISOString()]);
    const oldPlaceholder=await inbound(tooLate,{at:new Date(now-150000).toISOString()});
    await db.query(
      "INSERT INTO inbound_processing_jobs(message_id,contact_id,channel,incoming_payload,status) "+
      "VALUES($1,$2,'whatsapp',$3::jsonb,'completed')",
      [oldPlaceholder,tooLate.id,JSON.stringify({
        unsupportedType:"unsupported",unsupportedErrors:[{code:131060}],
      })]);
    await inbound(tooLate,{at:new Date(now-28000).toISOString(),ad:true});
    assert.equal(await isSecondaryAdsOnlyEligible(tooLate.id,{database:db,env:adOnly}),false,
      "a separate ad click outside two minutes cannot inherit first-contact status");

    const unknown=await contact(true);
    const unknownOld=await inbound(unknown,{at:new Date(now-50000).toISOString()});
    assert.equal(await isSecondaryAutomationEligible(unknown.id,{
      database:db,env,inboundMessageId:unknownOld}),false,
      "old direct enquiry cannot be resumed after rollout");
    await db.query("UPDATE contacts SET mode='human' WHERE id=$1",[direct.id]);
    assert.equal(await isSecondaryAutomationEligible(direct.id,{
      database:db,env,inboundMessageId:fresh}),false,"staff takeover blocks");
    await db.query("UPDATE contacts SET mode='ai',needs_attention=TRUE WHERE id=$1",[direct.id]);
    assert.equal(await isSecondaryAutomationEligible(direct.id,{
      database:db,env,inboundMessageId:fresh}),false,"staff attention blocks");
    await db.query("UPDATE contacts SET needs_attention=FALSE,whatsapp_opt_out_at=NOW() WHERE id=$1",[direct.id]);
    assert.equal(await isSecondaryAutomationEligible(direct.id,{
      database:db,env,inboundMessageId:fresh}),false,"customer opt-out blocks");

    // Parse all candidate and recheck selectors against real PostgreSQL types
    // with BOTH immutable timestamps. A test database has no enabled rules or
    // media jobs, so these queries cannot send anything.
    const base=["neutro_secondary","100000000000023","200000000000023"];
    const params=[...base,new Date(now),10,cutover,"all_contacts",legacy];
    await db.query(followup.CANDIDATES_SQL,[...params,null]);
    await db.query(followup.POTENTIAL_DUE_SQL,
      [...base,new Date(now),cutover,"all_contacts",legacy,null]);
    await db.query(marketing.CANDIDATES_SQL,params);
    await db.query(marketing.POTENTIAL_DUE_SQL,[...base,new Date(now),cutover,"all_contacts",legacy]);
    await db.query(media.READY_SQL,[...base,5,cutover,"all_contacts",legacy]);
    await db.query(media.STILL_VALID_SQL,[0,...base,cutover,"all_contacts",legacy]);
    assert.match(secondaryAutomationEligibleSql("c","$6","inbound","$7","$8"),
      /old_sync.message_id=inbound.id/);
  }finally{
    await db.query("SET search_path TO public").catch(()=>{});
    await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await db.end();
  }
});
