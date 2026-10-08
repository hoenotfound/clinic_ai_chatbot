const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");
const deliveryRepo = require("../src/db/whatsappDeliveryStatusRepo");
const connectionString = process.env.TEST_DATABASE_URL;

test("Postgres free-entry candidate, claim/recheck, post-reply silence and billing guards",
  { skip: !connectionString }, async () => {
  const client = new Client({ connectionString });
  const schema = "free_entry_" + process.pid + "_" + Date.now();
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(`
      CREATE TABLE contacts(
        id INTEGER PRIMARY KEY, channel TEXT, whatsapp_number TEXT, mode TEXT,
        needs_attention BOOLEAN DEFAULT false, whatsapp_opt_in_at TIMESTAMPTZ,
        whatsapp_opt_in_source TEXT, whatsapp_opt_out_at TIMESTAMPTZ,
        whatsapp_marketing_opt_out_at TIMESTAMPTZ
      );
      CREATE TABLE pipeline_stages(id INTEGER PRIMARY KEY, stage_type TEXT, system_key TEXT);
      CREATE TABLE leads(
        id INTEGER PRIMARY KEY, contact_id INTEGER, marketing_consent TEXT,
        is_closed BOOLEAN, appointment_status TEXT, stage_id INTEGER,
        created_at TIMESTAMPTZ, treatment_interest TEXT
      );
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id),
        role TEXT, content TEXT, created_at TIMESTAMPTZ,
        whatsapp_message_id TEXT, sent_by_username TEXT, delivery_status TEXT
      );
      CREATE TABLE lead_attributions(
        lead_id INTEGER REFERENCES leads(id), first_message_id INTEGER,
        channel TEXT, meta_source_type TEXT, ctwa_clid TEXT, meta_ad_id TEXT
      );
    `);
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/014_whatsapp_delivery_status_jobs.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/054_whatsapp_free_entry_followups.sql"), "utf8"));
    await client.query(`
      INSERT INTO contacts(id, channel, whatsapp_number, mode, needs_attention,
        whatsapp_opt_in_at, whatsapp_opt_in_source)
      VALUES (1, 'whatsapp', '60121234567', 'ai', false, now()-interval '4 days', 'customer checked consent form');
      INSERT INTO pipeline_stages(id,stage_type,system_key) VALUES (1,'open','new');
      INSERT INTO leads(id,contact_id,marketing_consent,is_closed,appointment_status,
        stage_id,created_at,treatment_interest)
      VALUES(1,1,'opted_in',false,'none',1,now()-interval '3 days','骨盆调理');
      INSERT INTO messages(id,contact_id,role,content,created_at) VALUES
        (10,1,'user','骨盆',now()-interval '55 hours');
      INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id,delivery_status)
      VALUES (11,1,'assistant','您好',now()-interval '54 hours','wamid.first','delivered');
      INSERT INTO lead_attributions(lead_id,first_message_id,channel,meta_source_type,ctwa_clid)
      VALUES(1,10,'whatsapp','ad','ctwa-1');
      INSERT INTO whatsapp_free_entry_pricing_evidence(wamid,pricing_type,billable,delivery_status)
      VALUES('wamid.first','free_entry_point',false,'delivered');
    `);
    const settings = {
      activatedAt: new Date(Date.now()-60*3600000).toISOString(),
      templateName:"ns_enquiry_reengagement", language:"auto",
      slots:[26,50,74], templateRules:[],
    };
    const list = () => worker.listCandidates(settings, client);
    const eligible = await list();
    assert.equal(eligible.length,1,"eligible CTWA lead appears in candidate queue");
    assert.equal(worker.selectedSlot(eligible[0], settings.slots),50);

    const fakePool = {connect: async () => ({
      query: client.query.bind(client),
      release: () => {},
    })};
    const claimedId = await worker.claim(eligible[0], 50, settings, fakePool);
    assert.ok(claimedId, "atomic Postgres claim succeeds");

    const recheck = await worker.listCandidates(settings, client, 1,
      {currentAttemptId: claimedId,excludeMessageId: null});
    assert.equal(recheck.length,1,
      "the claim does not suppress its own pre-provider eligibility recheck");
    assert.equal((await list()).length,0,
      "another worker does not select the claimed lead");

    await client.query(`UPDATE whatsapp_free_entry_followup_attempts
      SET status='accepted', wamid='wamid.slot', updated_at=now() WHERE id=$1`,[claimedId]);
    assert.equal((await list()).length,0,
      "future reminders wait for actual nonbillable Meta callback");
    await client.query(`INSERT INTO whatsapp_free_entry_pricing_evidence
      (wamid,pricing_type,billable,delivery_status)
      VALUES ('wamid.slot','free_entry_point',false,'delivered')`);
    assert.equal((await list()).length,0,
      "unclaimed next slot cannot send before it is due");

    // Customer replied after initial reply, then got an actual business reply.
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at)
      VALUES (12,1,'user','还有吗',now()-interval '30 hours')`);
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id)
      VALUES (13,1,'assistant','有的',now()-interval '29 hours','wamid.second')`);
    const recovered = await worker.listCandidates(settings, client, 1);
    assert.equal(recovered.length,1,
      "the customer is not permanently barred merely for replying");
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at)
      VALUES(14,1,'user','谢谢',now()-interval '1 hour')`);
    assert.equal((await worker.listCandidates(settings,client,1)).length,0,
      "new customer message closes the marketing automation window");
    await client.query(`DELETE FROM messages WHERE id=14`);
    const query = client.query.bind(client);
    await deliveryRepo.storeBatch([
      {wamid:"wamid.slot",status:"delivered",pricingType:"regular",pricingBillable:true},
    ],query);
    await deliveryRepo.storeBatch([
      {wamid:"wamid.slot",status:"read",pricingType:"free_entry_point",pricingBillable:false},
    ],query);
    const billing = await client.query(
      "SELECT billable, pricing_type FROM whatsapp_free_entry_pricing_evidence WHERE wamid='wamid.slot'");
    assert.equal(billing.rows[0].billable,true,"billable evidence is monotonic across out-of-order callbacks");
    assert.equal((await worker.listCandidates(settings,client,1)).length,0,
      "a confirmed charged template permanently blocks future slots");
  } finally {
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await client.end();
  }
});
