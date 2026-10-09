const test = require("node:test");
const assert = require("node:assert/strict");
const { Client, Pool } = require("pg");
const zeroCostGuard = require("../src/services/whatsappZeroCostGuard");
const freeOnlyReconciliation = require("../src/services/whatsappFreeOnlyReconciliationService");
const clinicConfig = require("../src/config/clinicConfig");
const fs = require("node:fs");
const path = require("node:path");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");
const deliveryRepo = require("../src/db/whatsappDeliveryStatusRepo");
const freeEntryReport = require("../src/db/whatsappFreeEntryReportRepo");
const { sessionLateralSql } = require("../src/db/whatsappFreeEntrySessionSql");
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
      CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE);
      CREATE TABLE meta_ad_insights_daily (
        ad_id TEXT, ad_name TEXT, insight_date DATE, updated_at TIMESTAMPTZ
      );
      CREATE TABLE leads(
        id INTEGER PRIMARY KEY, contact_id INTEGER, marketing_consent TEXT,
        is_closed BOOLEAN, appointment_status TEXT, stage_id INTEGER,
        started_message_id INTEGER,
        created_at TIMESTAMPTZ, treatment_interest TEXT
      );
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id),
        role TEXT, content TEXT, created_at TIMESTAMPTZ,
        whatsapp_message_id TEXT, sent_by_username TEXT, delivery_status TEXT,
        whatsapp_template JSONB
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
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/057_whatsapp_free_entry_referrals.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/059_whatsapp_free_only_safety.sql"), "utf8"));
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/056_whatsapp_free_entry_skips.sql"), "utf8"));
    await client.query(`
      INSERT INTO contacts(id, channel, whatsapp_number, mode, needs_attention,
        whatsapp_opt_in_at, whatsapp_opt_in_source)
      VALUES (1, 'whatsapp', '60121234567', 'ai', false, now()-interval '4 days', 'customer checked consent form');
      INSERT INTO pipeline_stages(id,stage_type,system_key) VALUES (1,'open','new');
      INSERT INTO users(id,username) VALUES(1,'admin'),(2,'staff');
      INSERT INTO leads(id,contact_id,marketing_consent,is_closed,appointment_status,
        stage_id,created_at,treatment_interest)
      VALUES(1,1,'opted_in',false,'none',1,now()-interval '3 days','骨盆调理');
      INSERT INTO messages(id,contact_id,role,content,created_at) VALUES
        (10,1,'user','骨盆',now()-interval '55 hours');
      INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id,delivery_status)
      VALUES (11,1,'assistant','您好',now()-interval '54 hours','wamid.first','delivered');
      INSERT INTO lead_attributions(lead_id,first_message_id,channel,meta_source_type,ctwa_clid)
      VALUES(1,10,'whatsapp','ad','ctwa-1');
      INSERT INTO whatsapp_free_entry_referrals
        (origin_message_id,contact_id,ctwa_clid,source_type)
      VALUES (10,1,'ctwa-1','ad');
      INSERT INTO whatsapp_free_entry_pricing_evidence(wamid,pricing_type,billable,delivery_status)
      VALUES('wamid.first','free_entry_point',false,'delivered');
    `);
    // Strict-mode integration: the current claimed follow-up is not a
    // "previous" send. A second worker cannot pass the account reservation.
    const oldFollowUp = clinicConfig.automatedFollowUp;
    const oldAccount = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const oldSevenDay = process.env.WHATSAPP_FEP_7DAY_VERIFIED;
    const guardDb = new Pool({
      connectionString, options: "-c search_path=" + schema, max: 4,
    });
    try {
      clinicConfig.automatedFollowUp = {
        ...oldFollowUp,
        whatsappFreeOnly: {
          enabled: true,
          activatedAt: new Date(Date.now()-3600000).toISOString(),
        },
      };
      process.env.WHATSAPP_PHONE_NUMBER_ID = "free-only-test-account";
      process.env.WHATSAPP_FEP_7DAY_VERIFIED = "false";

      // Strict-mode day 4–7 proof is obtained from any independently
      // delivered nonbillable CTWA message, not only a worker-claimed slot.
      // The worker and provider guard MUST report the same ceiling.
      process.env.WHATSAPP_FEP_7DAY_VERIFIED = "true";
      assert.equal(await zeroCostGuard.authorizedCeilingHours({database:guardDb}),72);
      assert.equal((await worker.alignedSettings({
        sevenDayVerified:true
      },guardDb)).sevenDayVerified,false,
      "the scheduler cannot consume a 74h slot while strict mode lacks proof");

      await client.query(`
        INSERT INTO contacts(id,channel,whatsapp_number,mode)
        VALUES(6,'whatsapp','60136666666','ai');
        INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id,delivery_status)
        VALUES
          (191,6,'user','Paid CTWA lead',now()-interval '82 hours','wamid.inbound.day7','delivered'),
          (192,6,'assistant','First reply',now()-interval '81 hours','wamid.fep.activated','delivered'),
          (193,6,'assistant','Previously verified outside strict mode',now()-interval '7 hours',
             'wamid.fep.day4','delivered');
        INSERT INTO whatsapp_free_entry_referrals
          (origin_message_id,contact_id,ctwa_clid,source_type)
        VALUES(191,6,'ctwa-independent-evidence','ad');
        INSERT INTO whatsapp_free_entry_pricing_evidence
          (wamid,pricing_type,billable,delivery_status)
        VALUES
          ('wamid.fep.activated','free_entry_point',false,'delivered'),
          ('wamid.fep.day4','regular',false,'delivered');
      `);
      assert.equal(await zeroCostGuard.authorizedCeilingHours({database:guardDb}),72,
        "nonbillable regular message does not prove seven-day CTWA free entry");
      await client.query(`
        UPDATE whatsapp_free_entry_pricing_evidence
        SET pricing_type='free_entry_point'
        WHERE wamid='wamid.fep.day4'
      `);
      // A second CTWA ad might open a NEW 72h window before the observed
      // message. Its free pricing must not be confused with a 7-day old FEP.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id,delivery_status)
        VALUES
          (194,6,'user','Another ad click',now()-interval '12 hours','wamid.inbound.new','delivered'),
          (195,6,'assistant','Another first reply',now()-interval '11 hours','wamid.opened.new','delivered');
        INSERT INTO whatsapp_free_entry_referrals
          (origin_message_id,contact_id,ctwa_clid,source_type)
        VALUES(194,6,'independent-second-ad','ad');
        INSERT INTO whatsapp_free_entry_pricing_evidence
          (wamid,pricing_type,billable,delivery_status)
        VALUES('wamid.opened.new','free_entry_point',false,'delivered');
      `);
      assert.equal(await zeroCostGuard.authorizedCeilingHours({database:guardDb}),72,
        "new ad re-entry never proves the original CTWA window extends to seven days");
      await client.query("DELETE FROM whatsapp_free_entry_pricing_evidence WHERE wamid='wamid.opened.new'");
      await client.query("DELETE FROM whatsapp_free_entry_referrals WHERE origin_message_id=194");
      await client.query("DELETE FROM messages WHERE id IN (194,195)");
      assert.equal(await zeroCostGuard.authorizedCeilingHours({database:guardDb}),168,
        "independent day-4 Meta free-entry callback verifies seven-day account eligibility");
      assert.equal((await worker.alignedSettings({sevenDayVerified:true},guardDb)).sevenDayVerified,true,
        "scheduler and guard agree when independent billing evidence exists");
      await client.query("DELETE FROM whatsapp_free_entry_pricing_evidence WHERE wamid IN ('wamid.fep.activated','wamid.fep.day4')");
      await client.query("DELETE FROM whatsapp_free_entry_referrals WHERE contact_id=6");
      await client.query("DELETE FROM messages WHERE contact_id=6");
      await client.query("DELETE FROM contacts WHERE id=6");
      assert.equal(await zeroCostGuard.authorizedCeilingHours({database:guardDb}),72,
        "strict mode fails closed again without current durable proof");
      process.env.WHATSAPP_FEP_7DAY_VERIFIED = "false";

      // Meta's genuine CTWA first reply IS the free-entry activation.
      // Verify strict mode lets this one text reply out without requiring a
      // pricing callback that cannot exist until AFTER it has been sent.
      await client.query(`
        INSERT INTO contacts(id,channel,whatsapp_number,mode)
        VALUES (2,'whatsapp','60137777777','ai'),
               (3,'whatsapp','60138888888','ai'),
               (4,'whatsapp','60139999999','ai');
        INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id)
        VALUES (170,2,'user','Real CTWA enquiry',now()-interval '2 minutes','wamid.ad.inbound'),
               (172,3,'user','Old ad enquiry',now()-interval '25 hours','wamid.old.inbound'),
               (174,4,'user','Organic enquiry',now()-interval '2 minutes','wamid.direct.inbound');
        INSERT INTO messages(id,contact_id,role,content,created_at,delivery_status)
        VALUES (171,2,'assistant','First ad reply',now()-interval '1 minute','unknown'),
               (173,3,'assistant','Late ad reply',now()-interval '1 minute','unknown'),
               (175,4,'assistant','Organic reply',now()-interval '1 minute','unknown');
        INSERT INTO whatsapp_free_entry_referrals(origin_message_id,contact_id,ctwa_clid,source_type)
        VALUES (170,2,'valid-ctwa-click','ad'),
               (172,3,'expired-ctwa-click','ad');
      `);
      const bootstrap=await zeroCostGuard.reserve("60137777777",{
        database:guardDb,context:{currentMessageId:171,messageKind:"first_reply_text"}});
      assert.equal(bootstrap.allowed,true,
        "one confirmed inbound CTWA ad permits its first text reply while the 24h window is open");
      const concurrentBootstrap=await zeroCostGuard.reserve("60137777777",{
        database:guardDb,context:{currentMessageId:171,messageKind:"first_reply_text"}});
      assert.equal(concurrentBootstrap.code,"zero_cost_previous_send_unreconciled",
        "a second business message cannot race ahead of the first provider pricing callback");
      await zeroCostGuard.complete(bootstrap.reservationId,
        {success:true,wamid:"wamid.ad.first.reply"},guardDb);
      const prePrice=await zeroCostGuard.reserve("60137777777",{
        database:guardDb,context:{messageKind:"template"}});
      assert.equal(prePrice.code,"zero_cost_previous_send_unreconciled",
        "Meta acceptance alone does not permit any template before billing proof");

      await client.query(`
        UPDATE messages SET whatsapp_message_id='wamid.ad.first.reply',
          delivery_status='delivered' WHERE id=171
      `);
      await client.query(`
        INSERT INTO whatsapp_free_entry_pricing_evidence
          (wamid,pricing_type,billable,delivery_status)
        VALUES ('wamid.ad.first.reply','free_entry_point',false,'delivered')
      `);
      const verified=await zeroCostGuard.reserve("60137777777",{
        database:guardDb,context:{messageKind:"template"}});
      assert.equal(verified.allowed,true,
        "subsequent templates may proceed only after Meta confirms the first reply was free");
      await zeroCostGuard.complete(verified.reservationId,
        {success:false,providerStatus:400},guardDb);

      const late=await zeroCostGuard.reserve("60138888888",{
        database:guardDb,context:{currentMessageId:173,messageKind:"first_reply_text"}});
      assert.equal(late.code,"zero_cost_unverified_free_entry",
        "an ad referral more than 24h old cannot bootstrap a free entry");
      const organic=await zeroCostGuard.reserve("60139999999",{
        database:guardDb,context:{currentMessageId:175,messageKind:"first_reply_text"}});
      assert.equal(organic.code,"zero_cost_unverified_free_entry",
        "ordinary WhatsApp profile/link/direct enquiry cannot obtain a CTWA first-reply exception");
      const unsafeMedia=await zeroCostGuard.reserve("60138888888",{
        database:guardDb,context:{currentMessageId:173,messageKind:"freeform"}});
      assert.equal(unsafeMedia.code,"zero_cost_unverified_free_entry",
        "an initial media/free-form path cannot invent a CTWA bootstrap");
      await client.query("DELETE FROM whatsapp_free_entry_referrals WHERE contact_id IN (2,3)");
      await client.query("DELETE FROM messages WHERE id BETWEEN 170 AND 175");
      await client.query("DELETE FROM contacts WHERE id IN (2,3,4)");

      await client.query(`
        INSERT INTO messages(id,contact_id,role,content,created_at,delivery_status)
        VALUES(19,1,'assistant','Current reserved follow-up',now(),'unknown');
      `);
      const pending = await client.query(`
        INSERT INTO whatsapp_free_entry_followup_attempts
          (contact_id,first_reply_message_id,slot_hours,message_id,status)
        VALUES(1,11,50,19,'sending') RETURNING id
      `);
      const attemptId = pending.rows[0].id;
      const ownContext = {
        currentMessageId: 19,
        currentFollowUpAttemptId: attemptId,
        messageKind: "template",
      };
      // After 24 hours since the last inbound, free-form is always blocked
      // even while a verified CTWA billing window remains active.
      const ordinary = await zeroCostGuard.reserve("60121234567", { database: guardDb });
      assert.equal(ordinary.code, "zero_cost_unverified_free_entry",
        "never send a non-template on Day 2");
      const withoutIdentity = await zeroCostGuard.reserve("60121234567", {
        database: guardDb, context: { messageKind: "template" },
      });
      assert.equal(withoutIdentity.code, "zero_cost_unverified_free_entry",
        "an unresolved pending message must not be ignored without identity");

      const [one, two] = await Promise.all([
        zeroCostGuard.reserve("60121234567", {database: guardDb, context: ownContext}),
        zeroCostGuard.reserve("60121234567", {database: guardDb, context: ownContext}),
      ]);
      assert.equal([one,two].filter(item=>item.allowed).length,1,
        "only one of two concurrently arriving worker requests can reserve");
      const winner=one.allowed?one:two;
      assert.equal((one.allowed?two:one).code,"zero_cost_previous_send_unreconciled");
      await assert.rejects(
        freeOnlyReconciliation.reconcile({
          actor:"admin",reservationId:winner.reservationId,
          reason:"I checked the chat, but the provider call is still active.",
          confirmedBillingHub:true,
        },guardDb),
        (error)=>error.code==="send_still_reserved",
        "an administrator cannot release an in-flight provider send"
      );

      const otherContact=await zeroCostGuard.reserve("60129876543",
        {database:guardDb,context:ownContext});
      assert.equal(otherContact.code,"zero_cost_previous_send_unreconciled",
        "the locked account cannot send to a second recipient");

      await zeroCostGuard.complete(winner.reservationId,
        {success:true,wamid:"wamid.strict.current"},guardDb);
      assert.equal((await zeroCostGuard.preflightTemplate("60121234567",
        {database:guardDb})).allowed,false,
        "unpriced accepted message does not allow the next scheduled template");
      assert.equal((await zeroCostGuard.reserve("60121234567",
        {database:guardDb,context:ownContext})).allowed,false,
        "provider acceptance alone never releases the account gate");

      await client.query(`
        UPDATE messages SET whatsapp_message_id='wamid.strict.current',
          delivery_status='delivered' WHERE id=19
      `);
      await client.query(`
        UPDATE whatsapp_free_entry_followup_attempts
          SET wamid='wamid.strict.current',status='accepted'
          WHERE id=$1
      `,[attemptId]);
      await client.query(`
        INSERT INTO whatsapp_free_entry_pricing_evidence
          (wamid,pricing_type,billable,delivery_status)
        VALUES('wamid.strict.current','free_entry_point',false,'delivered')
      `);
      assert.equal((await zeroCostGuard.preflightTemplate("60121234567",
        {database:guardDb})).allowed,true,
        "scheduled template preflight resumes after confirmed free callback, even while gate still awaits lazy release");

      // A second current follow-up is allowed to stage its own pending rows.
      await client.query(`
        INSERT INTO messages(id,contact_id,role,content,created_at,delivery_status)
        VALUES(20,1,'assistant','Another claimed follow-up',now(),'unknown')
      `);
      const secondClaim = await client.query(`
        INSERT INTO whatsapp_free_entry_followup_attempts
          (contact_id,first_reply_message_id,slot_hours,message_id,status)
        VALUES(1,11,26,20,'sending') RETURNING id
      `);
      const next = await zeroCostGuard.reserve("60121234567", {
        database:guardDb,
        context:{currentMessageId:20,currentFollowUpAttemptId:secondClaim.rows[0].id,
          messageKind:"template"},
      });
      assert.equal(next.allowed,true,
        "Meta confirmed nonbillable pricing permits another claimed follow-up");
      await zeroCostGuard.complete(next.reservationId,
        {success:false,ambiguous:true},guardDb);
      assert.equal((await zeroCostGuard.reserve("60121234567",
        {database:guardDb})).allowed,false,"unknown send stays locked");

      await assert.rejects(
        freeOnlyReconciliation.reconcile({
          actor:"admin",reservationId:next.reservationId,
          reason:"I checked the Meta billing evidence and recent delivery details.",
          confirmedBillingHub:true,
        },guardDb),
        (error)=>error.code==="reconciliation_grace_period",
        "an uncertain provider response must not be released immediately"
      );
      await guardDb.query(
        "UPDATE whatsapp_free_only_send_gate SET updated_at=now()-interval '6 minutes' WHERE reservation_id=$1",
        [next.reservationId]
      );
      const released=await freeOnlyReconciliation.reconcile({
        actor:"admin",reservationId:next.reservationId,
        reason:"Reviewed the exact WhatsApp conversation and Meta billing records; no unmatched delivery remains.",
        confirmedBillingHub:true,
      },guardDb);
      assert.equal(released.success,true);
      const audit=await guardDb.query(`
        SELECT actor,prior_status,verified_billing_hub
        FROM whatsapp_free_only_reconciliations
        WHERE reservation_id=$1
      `,[next.reservationId]);
      assert.equal(audit.rows[0].prior_status,"unknown");
      assert.equal(audit.rows[0].verified_billing_hub,true);
      assert.equal(audit.rows[0].actor,"admin");
      const proofOfScopedRecovery=await guardDb.query(`
        SELECT message_id,attempt_id FROM whatsapp_free_only_reconciliations
        WHERE reservation_id=$1
      `,[next.reservationId]);
      assert.equal(proofOfScopedRecovery.rows[0].message_id,20);
      assert.equal(String(proofOfScopedRecovery.rows[0].attempt_id),
        String(secondClaim.rows[0].id));
      // The follow-up candidate query must also recognize the reconciled
      // unknown attempt. It must never re-claim its original slot.
      await client.query(
        "UPDATE messages SET created_at=now()-interval '6 hours' WHERE id IN (19,20)"
      );
      const restoredCandidates=await worker.listCandidates({
        activatedAt: new Date(Date.now()-60*3600000).toISOString(),
        slots:[26,50,74],sevenDayVerified:false,
      },client,1);
      assert.equal(restoredCandidates.length,1,
        "a manually audited unknown attempt cannot starve later eligible slots");
      assert.ok(restoredCandidates[0].claimed_slots.includes(26),
        "the recovered 26h slot remains claimed and cannot be resent");

      const resumed=await zeroCostGuard.reserve("60121234567",{
        database:guardDb,context:{messageKind:"template"}});
      assert.equal(resumed.allowed,true,
        "audited recovery excludes only its own former pending rows");
      await zeroCostGuard.complete(resumed.reservationId,
        {success:false,providerStatus:400},guardDb);

      // An ID from another lead must not exempt the current conversation.
      const invalid = await zeroCostGuard.reserve("60129876543",
        {database:guardDb,context:{currentMessageId:19}});
      assert.equal(invalid.code,"zero_cost_invalid_send_context");

      // A Render crash after reserve cannot silently unlock a send.
      // Stale "reserved" becomes "unknown", not "idle", after 15 minutes.
      const crashed=await zeroCostGuard.reserve("60121234567",{
        database:guardDb,context:{messageKind:"template"}});
      assert.equal(crashed.allowed,true);
      await guardDb.query(
        "UPDATE whatsapp_free_only_send_gate SET updated_at=now()-interval '16 minutes' WHERE reservation_id=$1",
        [crashed.reservationId]
      );
      const stale=await zeroCostGuard.reserve("60121234567",{
        database:guardDb,context:{messageKind:"template"}});
      assert.equal(stale.code,"zero_cost_previous_send_unreconciled");
      const staleGate=await guardDb.query(
        "SELECT status FROM whatsapp_free_only_send_gate WHERE reservation_id=$1",
        [crashed.reservationId]
      );
      assert.equal(staleGate.rows[0].status,"unknown");
      await assert.rejects(
        freeOnlyReconciliation.reconcile({
          actor:"admin",reservationId:crashed.reservationId,
          reason:"Checked the entire WhatsApp chat and Meta billing entries; prior send was interrupted.",
          confirmedBillingHub:true
        },guardDb),
        (error)=>error.code==="reconciliation_grace_period",
        "newly classified unknown send still requires an investigation grace period"
      );

      await client.query("DELETE FROM whatsapp_free_entry_followup_attempts WHERE id=$1",[attemptId]);
      await client.query("DELETE FROM whatsapp_free_entry_followup_attempts WHERE id=$1",[secondClaim.rows[0].id]);
      await client.query("DELETE FROM messages WHERE id IN (19,20)");
    } finally {
      clinicConfig.automatedFollowUp = oldFollowUp;
      if (oldAccount === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      else process.env.WHATSAPP_PHONE_NUMBER_ID = oldAccount;
      if (oldSevenDay === undefined) delete process.env.WHATSAPP_FEP_7DAY_VERIFIED;
      else process.env.WHATSAPP_FEP_7DAY_VERIFIED = oldSevenDay;
      await guardDb.end();
    }

    const settings = {
      activatedAt: new Date(Date.now()-60*3600000).toISOString(),
      templateName:"ns_enquiry_reengagement", language:"auto",
      slots:[26,50,74], templateRules:[],
    };
    const list = () => worker.listCandidates(settings, client);
    const eligible = await list();
    assert.equal(eligible.length,1,"eligible CTWA lead appears in candidate queue");
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,sent_by_username,whatsapp_message_id)
      VALUES (15,1,'assistant','automated follow-up',now()-interval '8 hours',
        'Follow-up automation','wamid.automation')`);
    assert.equal((await list()).length,1,
      "normal follow-up automation must not be mistaken for a human staff reply");
    await client.query("DELETE FROM messages WHERE id=15");
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,sent_by_username,whatsapp_message_id)
      VALUES (16,1,'assistant','human reply',now()-interval '8 hours','admin','wamid.human')`);
    assert.equal((await list()).length,0,
      "actual user account staff message stops automated marketing");
    await client.query("DELETE FROM messages WHERE id=16");
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

    // A temporary strict billing race can reject a template BEFORE the Meta
    // API call, after the worker has already claimed its one-shot slot.
    // Retrying is safe ONLY for the explicit deferral marker + a cancelled
    // saved message with no provider ID (and no attempt WAMID).
    await client.query(`
      INSERT INTO messages(id,contact_id,role,content,created_at,delivery_status)
      VALUES(30,1,'assistant','Temporarily blocked by another send',now(),'cancelled')
    `);
    await client.query(`
      UPDATE whatsapp_free_entry_followup_attempts
      SET status='cancelled',message_id=30,wamid=NULL,error=$2
      WHERE id=$1
    `,[claimedId,worker.SAFE_POLICY_DEFERRAL]);
    const retryable=await list();
    assert.equal(retryable.length,1,
      "a definitely-unsent strict policy deferral is visible again");
    assert.equal(retryable[0].claimed_slots.includes(50),false,
      "safe deferred slot is not treated as used");
    const retryId=await worker.claim(eligible[0],50,settings,fakePool);
    assert.equal(String(retryId),String(claimedId),
      "retry reclaims the SAME unique slot, never inserts a second attempt");
    const recycled=await client.query(
      "SELECT status,message_id,wamid,error FROM whatsapp_free_entry_followup_attempts WHERE id=$1",
      [claimedId]
    );
    assert.equal(recycled.rows[0].status,"sending");
    assert.equal(recycled.rows[0].message_id,null);
    assert.equal(recycled.rows[0].wamid,null);
    assert.equal(recycled.rows[0].error,null);
    assert.equal((await list()).length,0,
      "concurrent workers cannot pick the just-reclaimed slot");

    // Consent/opt-out policy cancellations, accepted provider attempts,
    // failed sends and ambiguous sends must never become retryable.
    await client.query(`
      UPDATE whatsapp_free_entry_followup_attempts
      SET status='cancelled',message_id=30,error='whatsapp_marketing_opt_out'
      WHERE id=$1
    `,[claimedId]);
    assert.equal((await list()).length,0,
      "marketing opt-out does not acquire a hidden retry path");
    await client.query(`
      UPDATE whatsapp_free_entry_followup_attempts
      SET status='cancelled',error=$2
      WHERE id=$1
    `,[claimedId,worker.SAFE_POLICY_DEFERRAL]);
    await client.query("UPDATE messages SET delivery_status='unknown' WHERE id=30");
    assert.equal((await list()).length,0,
      "unknown message delivery cannot satisfy the safe deferral predicate");
    await client.query("UPDATE messages SET delivery_status='cancelled',whatsapp_message_id='wamid.unexpected' WHERE id=30");
    assert.equal((await list()).length,0,
      "any provider message ID prevents retry regardless of deferral marker");
    await client.query("UPDATE messages SET whatsapp_message_id=NULL WHERE id=30");
    await client.query(`
      UPDATE whatsapp_free_entry_followup_attempts
      SET status='unknown',error='outbound timed out'
      WHERE id=$1
    `,[claimedId]);
    assert.equal((await list()).length,0,
      "an ambiguous provider send is never automatically retried");
    await client.query(`
      UPDATE whatsapp_free_entry_followup_attempts
      SET status='sending',message_id=NULL,error=NULL
      WHERE id=$1
    `,[claimedId]);
    await client.query("DELETE FROM messages WHERE id=30");

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

    // A second verified ad click on an existing lead starts a NEW independently
    // priced entry, while CRM first-touch remains immutable.
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at)
      VALUES (20,1,'user','new ad click',now()-interval '4 hours')`);
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at,whatsapp_message_id)
      VALUES(21,1,'assistant','new ad reply',now()-interval '3 hours','wamid.second-entry')`);
    await client.query(`INSERT INTO whatsapp_free_entry_referrals
      (origin_message_id,contact_id,meta_ad_id,source_type)
      VALUES(20,1,'ad-2','ad')`);
    await client.query(`INSERT INTO whatsapp_free_entry_pricing_evidence
      (wamid,pricing_type,billable,delivery_status)
      VALUES('wamid.second-entry','free_entry_point',false,'delivered')`);
    const anchored = await client.query(
      `SELECT referral.origin_message_id FROM contacts c
       ${sessionLateralSql({ contactAlias:'c', ceilingParam:'$1' })}
       WHERE c.id=1`, [72]);
    assert.equal(Number(anchored.rows[0].origin_message_id),10,
      "new ad click inside an active FEP epoch MUST NOT restart the original billing clock");
    const newEntry = await worker.listCandidates(settings,client,1);
    assert.equal(newEntry.length,0,"new enquiry pauses automation during fresh 24h silence");
    const oldFirstTouch = await client.query(
      "SELECT first_message_id FROM lead_attributions WHERE lead_id=1");
    assert.equal(oldFirstTouch.rows[0].first_message_id,10,"original attribution remains unchanged");
    // Once the initial period is truly over, an independently priced ad entry
    // can begin a new epoch even though the original CRM attribution persists.
    await client.query(`UPDATE messages SET created_at=now()-interval '205 hours' WHERE id=10`);
    await client.query(`UPDATE messages SET created_at=now()-interval '204 hours' WHERE id=11`);
    await client.query(`UPDATE messages
      SET created_at=now()-interval '27 hours' WHERE id=20`);
    await client.query(`UPDATE messages
      SET created_at=now()-interval '26 hours' WHERE id=21`);
    await client.query(`INSERT INTO meta_ad_insights_daily
      (ad_id,ad_name,insight_date,updated_at)
      VALUES('ad-2','3D 小颜术 Face','2026-10-08',now())`);
    const repeatCandidate = (await worker.listCandidates(settings,client,1))[0];
    assert.equal(repeatCandidate.referral_ad_name,"3D 小颜术 Face",
      "ad name resolves from actual current ad ID, not stale CRM treatment");
    assert.equal(Number(repeatCandidate.first_reply_message_id),21,
      "a second ad-entry uses the newer Meta-confirmed business reply");
    assert.equal(worker.selectedSlot(repeatCandidate,settings.slots),26,
      "the new ad-entry can start its own 26h follow-up sequence");
    const report = await freeEntryReport.summarize(client);
    assert.equal(report.leads.ad_leads,1,
      "summary counts independently verified CTWA contacts, not only first-touch ads");
    assert.equal(report.leads.verified_free_entry,1,
      "summary uses latest independently validated billing epoch");
    assert.equal(report.contactDetails[0].first_reply_at != null,true,
      "contact-level dashboard uses the same non-overlapping entry clock");

  } finally {
    await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => {});
    await client.end();
  }
});
