const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { pool } = require("../src/db/db");
const contacts = require("../src/db/contactsRepo");
const telegram = require("../src/services/telegramImmediateAlertService");
const push = require("../src/services/webPushNotificationService");
const { followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");

test("Postgres preserves distinct pending questions and gates unsafe follow-ups", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `ai_review_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  const oldTelegram = telegram.sendAiReviewAlert;
  const oldPush = push.sendContactAlertBestEffort;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (id integer primary key, mode text default 'ai', takeover_by text, takeover_at timestamptz,
        is_unread boolean default false,
        needs_attention boolean default false, attention_reason text,
        updated_at timestamptz default now());
      CREATE TABLE messages (id integer primary key, contact_id integer references contacts(id),
        role text, content text, delivery_status text, sent_by_username text,
        is_automated_follow_up boolean NOT NULL DEFAULT false,
        whatsapp_message_id text,
        created_at timestamptz not null default now());
      CREATE TABLE outbound_message_evidence (
        message_id integer primary key references messages(id), accepted boolean not null,
        origin text
      );
    `);
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/064_ai_review_items.sql"), "utf8"));
    await client.query(`
      INSERT INTO contacts(id) VALUES (1);
      INSERT INTO messages(id, contact_id, role, content) VALUES
        (10,1,'user','Card payment?'),(11,1,'user','Recent HIFU?'),(12,1,'user','Parking?');
    `);
    let notified = 0;
    pool.query = (...args) => client.query(...args);
    telegram.sendAiReviewAlert = async () => { notified++; return {status:"queued"}; };
    push.sendContactAlertBestEffort = () => {};

    const first = await contacts.setAiReviewAttention(1,10,"Card payment?","information");
    assert.equal(first.mode,"ai");
    assert.equal(first.needs_attention,true);
    await contacts.setAiReviewAttention(1,10,"Duplicate retry","information");
    assert.equal(notified,1);
    const reviewAlert = {
      contact_id: 1, alert_type: "ai_review", event_key: "ai-review:1:10",
    };
    assert.equal(
      await telegram.shouldSendImmediateAlert(reviewAlert, client.query.bind(client)),
      true, "review alert is valid while AI owns the open question"
    );
    let permission = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permission.rows[0].allowed,true);
    assert.equal(await contacts.canSendAutomaticReviewMedia(1), true,
      "informational review permits independently eligible pictures");

    const next = await contacts.setAiReviewAttention(1,11,"Recent HIFU?","clinical");
    assert.equal(next.mode,"ai");
    assert.ok(next.attention_reason.includes("#10"));
    assert.ok(next.attention_reason.includes("#11"));
    assert.equal(notified,2);
    permission = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permission.rows[0].allowed,false);
    assert.equal(await contacts.canSendAutomaticReviewMedia(1), false,
      "clinical review blocks every automatic picture");

    // A higher-priority alert may override the contact tooltip while the
    // review rows remain. A staff-assist reply must not hide those rows.
    await client.query("UPDATE contacts SET attention_reason='Delivery failed', needs_attention=true, updated_at=date_trunc('milliseconds', now()) WHERE id=1");
    const prior = (await client.query("SELECT * FROM contacts WHERE id=1")).rows[0];
    const afterAssist = await contacts.clearStaffAssistStateIfUnchanged(prior);
    assert.equal(afterAssist.needs_attention, true);
    assert.match(afterAssist.attention_reason, /AI review requested/);
    assert.match(afterAssist.attention_reason, /#10/);
    assert.match(afterAssist.attention_reason, /#11/);
    // A Human takeover must never reenable automated marketing even if the
    // general Attention flag is manually cleared.
    await client.query("UPDATE contacts SET mode='human',needs_attention=false,attention_reason=NULL WHERE id=1");
    const humanGate = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(humanGate.rows[0].allowed, false);
    assert.equal(
      await telegram.shouldSendImmediateAlert(reviewAlert, client.query.bind(client)),
      false, "staff takeover invalidates queued AI Active alerts"
    );
    assert.equal(await contacts.canSendAutomaticReviewMedia(1), false,
      "staff-owned conversations must never send automatic pictures");
    await client.query("UPDATE contacts SET mode='ai',needs_attention=true,attention_reason='AI review requested: pending' WHERE id=1");

    const pending = await client.query("SELECT inbound_message_id, category FROM ai_review_items WHERE status='pending' ORDER BY inbound_message_id");
    assert.deepEqual(pending.rows, [
      {inbound_message_id:10,category:"information"},
      {inbound_message_id:11,category:"clinical"},
    ]);
    // Staff takeover can clear the visible alert without resolving the
    // individual question records. Returning to AI must restore those reviews,
    // and a pending clinical question must still block unsolicited follow-ups.
    await client.query("UPDATE contacts SET mode='human', needs_attention=false, attention_reason=NULL WHERE id=1");
    let permissionAfterTakeover = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permissionAfterTakeover.rows[0].allowed,false);
    const returnedToAi = await contacts.returnToAi(1);
    assert.equal(returnedToAi.mode,"ai");
    assert.equal(returnedToAi.needs_attention,true);
    assert.ok(returnedToAi.attention_reason.includes("#10"));
    assert.ok(returnedToAi.attention_reason.includes("#11"));
    permissionAfterTakeover = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permissionAfterTakeover.rows[0].allowed,false);

    const reviewToResolve = await client.query(
      "SELECT id FROM ai_review_items WHERE inbound_message_id=10"
    );
    const individuallyResolved = await contacts.resolveAiReviewItem(1, reviewToResolve.rows[0].id);
    assert.equal(individuallyResolved.needs_attention, true);
    assert.ok(!individuallyResolved.attention_reason.includes("#10"));
    assert.ok(individuallyResolved.attention_reason.includes("#11"));
    permissionAfterTakeover = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permissionAfterTakeover.rows[0].allowed, false);
    // Re-resolving is a no-op; a second review must never be cleared.
    assert.equal(await contacts.resolveAiReviewItem(1, reviewToResolve.rows[0].id), null);
    assert.equal(
      await telegram.shouldSendImmediateAlert(reviewAlert, client.query.bind(client)),
      false, "resolving the question cancels its queued review alert"
    );

    const resolvedContact = await contacts.dismissAttentionAndReviews(1);
    assert.equal(resolvedContact.needs_attention,false);
    assert.equal(await contacts.canSendAutomaticReviewMedia(1), true,
      "staff dismissal restores eligible media once all clinical reviews resolve");
    const resolved = await client.query("SELECT count(*)::int AS n FROM ai_review_items WHERE status='resolved'");
    assert.equal(resolved.rows[0].n,2);
    await contacts.setAiReviewAttention(1,12,"Parking policy?","information");
    assert.equal(notified,3);
    const current = await client.query("SELECT count(*)::int AS n FROM ai_review_items WHERE status='pending'");
    assert.equal(current.rows[0].n,1);

    // Resolving review questions must not dismiss a separate booking/staff issue.
    await client.query(`UPDATE contacts
      SET needs_attention=true, attention_reason='Booking Ready: Staff must confirm'
      WHERE id=1`);
    const preservedBooking = await contacts.dismissAttentionAndReviews(1);
    assert.equal(preservedBooking.needs_attention, true);
    assert.equal(preservedBooking.attention_reason, "Booking Ready: Staff must confirm");
    assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM ai_review_items WHERE status='pending'")).rows[0].n, 0);
    // A subsequent explicit attention dismissal (with no reviews left) still works.
    const dismissedBooking = await contacts.dismissAttentionAndReviews(1);
    assert.equal(dismissedBooking.needs_attention, false);
    assert.equal(dismissedBooking.attention_reason, null);

    // A previously failed send must remain visible even when the contact-level
    // reason was an AI review, instead of silently disappearing on bulk dismissal.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,content,delivery_status) VALUES
        (13,1,'user','Does your clinic accept online booking?',null),
        (14,1,'assistant','Missed image','failed');
    `);
    await contacts.setAiReviewAttention(1,13,"Booking questions?","information");
    const preservedFailure = await contacts.dismissAttentionAndReviews(1);
    assert.equal(preservedFailure.needs_attention, true);
    assert.match(preservedFailure.attention_reason, /Delivery failed/);

    // The same failed message must remain visible when staff reply cleanup
    // runs with a separate AI review still pending.
    await client.query("INSERT INTO messages(id,contact_id,role,content) VALUES (15,1,'user','Clinical question')");
    await contacts.setAiReviewAttention(1,15,"Clinical question?","clinical");
    const staffSnapshot = (await client.query("SELECT * FROM contacts WHERE id=1")).rows[0];
    const afterStaffReply = await contacts.clearStaffAssistStateIfUnchanged(staffSnapshot);
    assert.equal(afterStaffReply.needs_attention,true);
    assert.match(afterStaffReply.attention_reason, /Delivery failed/);
    assert.equal((await client.query(
      "SELECT COUNT(*)::int AS n FROM ai_review_items WHERE status='pending'"
    )).rows[0].n, 1, "manual staff replies do not resolve review questions");
    assert.equal(await contacts.canSendAutomaticReviewMedia(1),false);

    // Review summaries stay independently available even while a delivery
    // alert takes priority in the one-line contact attention reason.
    const pendingReview = await client.query(
      "SELECT id FROM ai_review_items WHERE inbound_message_id=15 AND status='pending'"
    );
    assert.equal(pendingReview.rows.length,1);

    // A prior unconfirmed delivery is also protected by staff cleanup.
    await client.query("UPDATE messages SET delivery_status='unknown' WHERE id=14");
    await client.query("UPDATE contacts SET attention_reason='Delivery unconfirmed: awaiting Meta' WHERE id=1");
    const unknownSnapshot = (await client.query("SELECT * FROM contacts WHERE id=1")).rows[0];
    const afterUnknown = await contacts.clearStaffAssistStateIfUnchanged(unknownSnapshot);
    assert.equal(afterUnknown.needs_attention,true);
    assert.equal(afterUnknown.attention_reason,'Delivery unconfirmed: awaiting Meta');

    // Recovered delivery statuses must stop preserving a stale failure flag.
    await client.query("UPDATE messages SET delivery_status='sent' WHERE id=14");
    const recoveredSnapshot = (await client.query("SELECT * FROM contacts WHERE id=1")).rows[0];
    const recoveredStaffReply = await contacts.clearStaffAssistStateIfUnchanged(recoveredSnapshot);
    assert.equal(recoveredStaffReply.needs_attention,true);
    assert.match(recoveredStaffReply.attention_reason, /AI review requested/);
    await contacts.resolveAiReviewItem(1,pendingReview.rows[0].id);

    // Legacy rows can have a true attention flag with a missing reason.
    // The staff-assist cleanup must never assign SQL NULL to needs_attention.
    await client.query(`UPDATE contacts SET needs_attention=true,
      attention_reason=NULL,updated_at=date_trunc('milliseconds',now()) WHERE id=1`);
    const inconsistentContact = (await client.query("SELECT * FROM contacts WHERE id=1")).rows[0];
    const cleanedLegacy = await contacts.clearStaffAssistStateIfUnchanged(inconsistentContact);
    assert.equal(cleanedLegacy.needs_attention, false);
    assert.equal(cleanedLegacy.attention_reason, null);

    // A delivered staff clarification followed by an explicit Return to AI
    // resolves only the old synthetic handoff flag, so a new staff-originated
    // follow-up cycle can qualify under the remaining scheduling safeguards.
    await client.query(`
      INSERT INTO messages(id,contact_id,role,content,created_at,sent_by_username,delivery_status)
      VALUES
        (20,1,'user','Is the treatment suitable?',now() + interval '1 minute',null,null),
        (21,1,'assistant','Staff clarification',now() + interval '2 minutes','staff','read')
    `);
    await client.query(`UPDATE contacts
      SET mode='human',takeover_by='staff',needs_attention=true,
          takeover_at=now() + interval '3 minutes',
          attention_reason='AI handed off this conversation.' WHERE id=1`);
    const replyPredatesHandoff = await contacts.returnToAi(1);
    assert.equal(replyPredatesHandoff.needs_attention, true,
      'A staff reply from before the handoff must not clear the warning');
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      takeover_at=now() + interval '90 seconds' WHERE id=1`);
    const resumed = await contacts.returnToAi(1);
    assert.equal(resumed.mode, 'ai');
    assert.equal(resumed.needs_attention, false);
    assert.equal(resumed.attention_reason, null);
    let resumeGate = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(resumeGate.rows[0].allowed, true);

    // Returning to AI without answering the latest customer must not
    // silently release a genuine unresolved handoff.
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at)
      VALUES (22,1,'user','A new question',now() + interval '3 minutes')`);
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      needs_attention=true,attention_reason='AI handed off this conversation.' WHERE id=1`);
    const unanswered = await contacts.returnToAi(1);
    assert.equal(unanswered, null, 'unanswered handoff must remain staff-owned');
    resumeGate = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(resumeGate.rows[0].allowed, false);

    // With no trustworthy handoff timestamp, even a confirmed staff answer
    // cannot silently clear an AI-owned stale flag. Staff can explicitly
    // dismiss attention after reviewing the chat.
    await client.query(`UPDATE contacts SET mode='ai',takeover_at=NULL,
      needs_attention=true,attention_reason='AI handed off this conversation.' WHERE id=1`);
    const missingBoundary = await contacts.returnToAi(1);
    assert.equal(missingBoundary, null, 'stale AI-owned handoffs must fail closed');

    // A later staff reply does not resolve a durable clinical review.
    await contacts.setAiReviewAttention(1,22,'New clinical question','clinical');
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at,sent_by_username,delivery_status)
      VALUES (23,1,'assistant','Staff answered',now() + interval '4 minutes','staff','read')`);
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      needs_attention=true,attention_reason='AI handed off this conversation.' WHERE id=1`);
    const pendingClinical = await contacts.returnToAi(1);
    assert.equal(pendingClinical, null, 'pending clinical review blocks handoff recovery');
    assert.equal((await client.query('SELECT mode FROM contacts WHERE id=1')).rows[0].mode, 'human');
    resumeGate = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(resumeGate.rows[0].allowed, false);
    await contacts.dismissAttentionAndReviews(1);

    // An unresolved delivery failure also prevents an old handoff flag from
    // being cleared, even with a confirmed staff response.
    await client.query(`INSERT INTO messages(id,contact_id,role,content,created_at,delivery_status)
      VALUES (24,1,'assistant','Undelivered image',now() + interval '5 minutes','failed')`);
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      needs_attention=true,attention_reason='AI handed off this conversation.' WHERE id=1`);
    const failedDelivery = await contacts.returnToAi(1);
    assert.equal(failedDelivery, null, 'unconfirmed outbound keeps the handoff staff-owned');
    await client.query("UPDATE messages SET delivery_status='sent' WHERE id=24");
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      takeover_at=now() + interval '90 seconds' WHERE id=1`);
    const deliveryRecovered = await contacts.returnToAi(1);
    assert.equal(deliveryRecovered.needs_attention, false);
    assert.equal(deliveryRecovered.attention_reason, null);

    // Accepted Business App staff echoes have provider IDs even when delivery
    // status is NULL, and should also resolve a current real handoff.
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      takeover_at=now() + interval '6 minutes',needs_attention=true,
      attention_reason='AI handed off this conversation.' WHERE id=1`);
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,sent_by_username,delivery_status,whatsapp_message_id)
      VALUES (25,1,'assistant','Business App echo',now() + interval '7 minutes',
       'external_staff',NULL,'wamid.businessapp.25')`);
    const businessAppAnswered = await contacts.returnToAi(1);
    assert.equal(businessAppAnswered.needs_attention, false);

    // A past failed send belongs to an older customer cycle, so it must not
    // prevent a safe resolved handoff from a more recent enquiry.
    await client.query(`UPDATE messages SET delivery_status='failed',
      created_at=now() - interval '2 hours' WHERE id=24`);
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      takeover_at=now() + interval '6 minutes',needs_attention=true,
      attention_reason='AI handed off this conversation.' WHERE id=1`);
    const oldFailure = await contacts.returnToAi(1);
    assert.equal(oldFailure.needs_attention,false);
    assert.equal(oldFailure.attention_reason,null);

    // A successful automated follow-up is not a real staff answer and cannot
    // clear a newer handoff even if it carries a synthetic sender username.
    await client.query(`UPDATE contacts SET mode='human',takeover_by='staff',
      takeover_at=now() + interval '9 minutes',needs_attention=true,
      attention_reason='AI handed off this conversation.' WHERE id=1`);
    await client.query(`INSERT INTO messages
      (id,contact_id,role,content,created_at,sent_by_username,delivery_status,is_automated_follow_up)
      VALUES (26,1,'assistant','Automated reminder',now() + interval '10 minutes',
      'Follow-up automation','read',true)`);
    const automationNotStaff = await contacts.returnToAi(1);
    assert.equal(automationNotStaff, null, 'automation is not proof of a staff answer');
  } finally {
    pool.query = oldQuery;
    telegram.sendAiReviewAlert = oldTelegram;
    push.sendContactAlertBestEffort = oldPush;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
