"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const repo=require("../src/db/standalonePricingReminderRepo");

const cs=process.env.TEST_DATABASE_URL;
test("standalone pricing uses migrated sender receipts, safe retry and captionless duplicate checks",{
  skip:!cs,
},async()=>{
 const db=new Client({connectionString:cs});
 const schema="standalone_pricing_"+process.pid+"_"+Date.now();
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
  await db.query("EXPLAIN "+repo.ELIGIBLE_SQL,[["neutro_secondary"],new Date(Date.now()-23*3600000).toISOString()]);
  const sender=(await db.query(
    "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,meta_account_id,display_name,state) "+
    "VALUES('neutro_secondary','100000000070700','200000000070700','Secondary test','active') RETURNING id"
  )).rows[0].id;
  const contact=(await db.query(
    "INSERT INTO contacts(channel,whatsapp_number,whatsapp_sender_id) "+
    "VALUES('whatsapp','60125117007',$1) RETURNING id",[sender])).rows[0].id;
  const conversation=(await db.query(
    "INSERT INTO whatsapp_sender_conversations(sender_id,contact_id,customer_wa_id,state) "+
    "VALUES($1,$2,'60125117007','bound') RETURNING id",[sender,contact])).rows[0].id;
  const inbound=(await db.query(
    "INSERT INTO messages(contact_id,role,content,created_at,source_created_at,whatsapp_message_id) "+
    "VALUES($1,'user','骨盆调理',NOW()-INTERVAL '22 hours',NOW()-INTERVAL '22 hours','wamid.synthetic.inbound') RETURNING id",
    [contact])).rows[0].id;
  const reply=(await db.query(
    "INSERT INTO messages(contact_id,role,content,created_at,delivery_status,whatsapp_message_id) "+
    "VALUES($1,'assistant','Welcome! Assessment first.',NOW()-INTERVAL '21 hours 59 minutes','delivered','wamid.synthetic.reply') RETURNING id",
    [contact])).rows[0].id;
  for(const msg of [inbound,reply])await db.query(
    "INSERT INTO whatsapp_sender_message_context(message_id,conversation_id) VALUES($1,$2)",
    [msg,conversation]);
  const activatedAt=new Date(Date.now()-23*3600000).toISOString();
  const opts={senderKeys:["neutro_secondary"],activatedAt};
  assert.equal((await repo.listCandidates(opts,db)).length,0,
    "no unsolicited promotional price without verified marketing permission");
  const lead=(await db.query(
    "INSERT INTO leads(contact_id,treatment_interest,marketing_consent) "+
    "VALUES($1,'骨盆调理','opted_in') RETURNING id",[contact])).rows[0].id;
  await db.query(
    "UPDATE contacts SET whatsapp_opt_in_at=NOW()-INTERVAL '23 hours', "+
    "whatsapp_opt_in_source='customer_whatsapp_text' WHERE id=$1",[contact]);
  const consent=(await db.query(
    "INSERT INTO whatsapp_marketing_consent_events"+
    "(contact_id,lead_id,source,message_id,provider_message_id,message_text,"+
    "business_name,consent_scope,consent_service,consent_category,consented_at,consent_method) "+
    "SELECT $1,$2,'ctwa_explicit_customer_message',$3,m.whatsapp_message_id,m.content,"+
    "'Neutro Sense TCM Centre','treatment_followups_and_related_offers',"+
    "'9D 逆龄抗衰','MARKETING',m.source_created_at,'customer_whatsapp_text' "+
    "FROM messages m WHERE m.id=$3 RETURNING id",
    [contact,lead,inbound])).rows[0].id;
  assert.equal((await repo.listCandidates(opts,db)).length,0,
    "wrong-service consent is not permission for pelvic prices");
  await db.query("UPDATE whatsapp_marketing_consent_events SET consent_service='骨盆调理' WHERE id=$1",[consent]);
  let rows=await repo.listCandidates(opts,db);
  assert.equal(rows.length,1);
  assert.equal(rows[0].recent_verified_treatment_consent,true,
    "a recent consent event tied to the lead and exact sender supports a vague reply");
  assert.equal(rows[0].ad_name,null,"no ad should be inferred from CRM only");
  await db.query(
    "INSERT INTO whatsapp_free_entry_referrals"+
    "(origin_message_id,contact_id,meta_ad_id,ad_name,treatment_interest,source_type) "+
    "VALUES($1,$2,'synthetic.neutro.pelvic','骨盆体验','骨盆调理','ad')",
    [inbound,contact]);
  rows=await repo.listCandidates(opts,db);
  assert.equal(rows.length,1);
  const c=rows[0];
  assert.equal(Number(c.contact_id),Number(contact));
  assert.equal(c.ad_name,"骨盆体验");
  assert.equal(c.ad_treatment_interest,"骨盆调理",
    "recent sender-bound ad proof supplies the safe fallback treatment");
  const a={caption:"Package A RM388",imageUrl:"/promo-images/40",
    packageName:"Package A",serviceName:"骨盆调理",identities:["/promo-images/40"]};
  const b={caption:"Package B RM288",imageUrl:"/promo-images/41",
    packageName:"Package B",serviceName:"骨盆调理",identities:["/promo-images/41"]};
  const first=await repo.claim(c,a,db);
  assert.ok(first?.id,"one-shot A claim must be persisted");
  assert.equal(await repo.stillEligible(c,first.id,opts,{...a,serviceName:"9D 逆龄抗衰"},db),false,
    "a changed treatment cannot reuse old consent at send time");
  assert.equal(await repo.stillEligible(c,first.id,opts,a,db),true);
  const deferred=await repo.deferUnsent(c,first,"secondary_billing_previous_send_unresolved",db);
  assert.equal(deferred.row.id,first.id);
  assert.equal(Number(deferred.retry.attempts),1);
  assert.equal(await repo.resumeDeferred(c,a,db),null,"do not retry before recorded backoff");
  await db.query("UPDATE pricing_reminder_preflight_retries SET retry_after=NOW()-INTERVAL '1 second' WHERE anchor_id=$1",[inbound]);
  const resumed=await repo.resumeDeferred(c,a,db);
  assert.equal(resumed.id,first.id,"reuse existing unsent claim without duplicate");
  assert.equal(await repo.claim(c,a,db),null);
  await db.query(
    "UPDATE messages SET whatsapp_message_id='wamid.synthetic.A',whatsapp_accepted_at=NOW(),delivery_status='pending' WHERE id=$1",
    [first.id]);
  assert.equal(await repo.claimAdditional(c,b,db),null,"no secondary B without signed A receipt");
  await db.query("INSERT INTO whatsapp_sender_billing_gates(sender_id,owner_contact_id,state) VALUES($1,$2,'idle')",
    [sender,contact]);
  assert.equal(await repo.claimAdditional(c,b,db),null,"idle gate alone is not delivery evidence");
  const reservation="11111111-1111-4111-8111-111111111107";
  await db.query(
    "INSERT INTO whatsapp_sender_billing_attempts(reservation_id,sender_id,contact_id,message_id,state,wamid,recipient_address) "+
    "VALUES($1,$2,$3,$4,'reconciled','wamid.synthetic.A','60125117007')",
    [reservation,sender,contact,first.id]);
  await db.query(
    "INSERT INTO whatsapp_sender_status_receipts"+
    "(fingerprint,sender_id,reservation_id,wamid,wamid_hash,delivery_status,meta_phone_number_id,meta_account_id,matched) "+
    "VALUES($1,$2,$3,'wamid.synthetic.A',$4,'delivered','100000000070700','200000000070700',TRUE)",
    ["a".repeat(64),sender,reservation,"b".repeat(64)]);
  const second=await repo.claimAdditional(c,b,db);
  assert.ok(second?.id,"verified signed receipt allows exactly one Package B");
  assert.equal(await repo.stillEligible(c,second.id,opts,b,db),true);
  assert.equal(await repo.claimAdditional(c,b,db),null,"no duplicate Package B claim");
  // An image sent from the Business App may have no caption and an alternate
  // absolute URL but is the same canonical configured graphic identity.
  await db.query(
    "INSERT INTO messages(contact_id,role,content,media_url,whatsapp_message_id,delivery_status) "+
    "VALUES($1,'assistant','','https://example.test/promo-images/41?token=opaque','wamid.staff.image','delivered')",
    [contact]);
  assert.equal(await repo.stillEligible(c,second.id,opts,b,db),false,
    "captionless existing image must prevent a duplicate");
  await db.query(
    "INSERT INTO messages(contact_id,role,content,media_key,media_mime_type,"+
    "sent_by_username,whatsapp_message_id,delivery_status) "+
    "VALUES($1,'assistant','','messages/price-graphic-renamed.jpg','image/jpeg',"+
    "'WhatsApp Business App','wamid.staff.manual.image','delivered')",[contact]);
  const staffImages=await repo.listRecentStaffImages(c,db);
  assert.equal(staffImages.length,1,"manual image must be checked even with a new R2 key");
  assert.equal(staffImages[0].sent_by_username,"WhatsApp Business App");
  assert.equal(Object.hasOwn(staffImages[0],"media_key"),false,"do not expose R2 keys to review query");
  assert.equal(await repo.recordDecision(c,"staff_review:Package B",db),true);
  assert.equal(await repo.recordDecision(c,"staff_review:Package B",db),false,
    "repeat review must not emit another staff alert");
  const audit=(await db.query("SELECT reason FROM standalone_pricing_reminder_decisions WHERE contact_id=$1",[contact])).rows;
  assert.deepEqual(audit.map(x=>x.reason),["standalone:staff_review:Package B"]);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
