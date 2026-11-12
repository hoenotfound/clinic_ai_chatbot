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
  const rows=await repo.listCandidates(opts,db);
  assert.equal(rows.length,1);
  const c=rows[0];
  assert.equal(Number(c.contact_id),Number(contact));
  const a={caption:"Package A RM388",imageUrl:"/promo-images/40",
    packageName:"Package A",serviceName:"骨盆调理",identities:["/promo-images/40"]};
  const b={caption:"Package B RM288",imageUrl:"/promo-images/41",
    packageName:"Package B",serviceName:"骨盆调理",identities:["/promo-images/41"]};
  const first=await repo.claim(c,a,db);
  assert.ok(first?.id,"one-shot A claim must be persisted");
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
  await repo.recordDecision(c,"staff_review:Package B",db);
  await repo.recordDecision(c,"staff_review:Package B",db);
  const audit=(await db.query("SELECT reason FROM standalone_pricing_reminder_decisions WHERE contact_id=$1",[contact])).rows;
  assert.deepEqual(audit.map(x=>x.reason),["standalone:staff_review:Package B"]);
 }finally{
  await db.query("SET search_path TO public").catch(()=>{});
  await db.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
  await db.end();
 }
});
