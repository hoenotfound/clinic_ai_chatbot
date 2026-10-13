"use strict";

// Strict RM0 is an account-wide serial send gate. Optional result pictures must
// not race the initial CTWA text's asynchronous Meta pricing callback.
// Persist only the picture plan, never a fake failed outbound message.
const crypto = require("node:crypto");
const { pool } = require("../db/db");
const conversationStore = require("../utils/conversationStore");
const messagesRepo = require("../db/messagesRepo");
const contactsRepo = require("../db/contactsRepo");
const channelMessaging = require("./channelMessagingService");
const zeroCost = require("./whatsappZeroCostGuard");
const { automatedRepliesEnabled } = require("./automaticReplyControl");
const aiReplyCancellation = require("./aiReplyCancellationService");
const { getAiOwnedContact } = require("./automaticReplyGuard");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");

const RETRY_MS = 2000;
const SPACING_MS = 1000;
const MAX_BILLING_WAIT_MS = 2 * 60 * 1000;
const UNKNOWN_AFTER_MS = 3 * 60 * 1000;
const IDLE_MS = 15 * 60 * 1000;
const TEMPORARY_BILLING_CODES = new Set([
  "zero_cost_previous_send_unreconciled",
  "zero_cost_unverified_free_entry",
  "zero_cost_database_unavailable",
]);
let worker = null;

function isTemporaryBillingBlock(result) {
  return Boolean(result && TEMPORARY_BILLING_CODES.has(result.code || result.policyCode));
}

async function enqueue({ contactId, inboundMessageId, items, kind="result", sequenceOffset=0 }, db = pool) {
  if (!zeroCost.enabled()) return false;
  if (!Number.isSafeInteger(contactId) || !Number.isSafeInteger(inboundMessageId) ||
      !["result","promotion"].includes(kind) ||
      !Number.isSafeInteger(sequenceOffset) || sequenceOffset<0 || sequenceOffset>4 ||
      !Array.isArray(items) || !items.length || items.length + sequenceOffset > 5 ||
      items.some(item => !item || typeof item.imageUrl !== "string" ||
        !item.imageUrl || item.caption != null && typeof item.caption !== "string")) {
    throw new Error("Invalid strict-RM0 result image plan");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (let index = 0; index < items.length; index++) {
      await client.query(
        `INSERT INTO whatsapp_result_media_queue
           (contact_id,inbound_message_id,sequence_no,media_kind,image_url,caption,next_attempt_at)
         VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 second')
         ON CONFLICT(inbound_message_id,sequence_no) DO NOTHING`,
        [contactId,inboundMessageId,index+sequenceOffset,kind,items[index].imageUrl,items[index].caption||""]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  wake(1000);
  return true;
}

async function reconcileAudit(inboundMessageId, db = pool) {
  // If Meta's receipt arrives before the inbound handler writes its audit,
  // create the audit seed first so accepted media can never be lost to a race.
  await db.query(
    `INSERT INTO result_media_decisions
       (contact_id,inbound_message_id,status,reason,result_images_selected)
     SELECT q.contact_id,$1,'deferred','awaiting_meta_free_billing',
       (SELECT COUNT(*) FROM whatsapp_result_media_queue
        WHERE inbound_message_id=$1 AND media_kind='result')
     FROM whatsapp_result_media_queue q
     WHERE q.inbound_message_id=$1 LIMIT 1
     ON CONFLICT(inbound_message_id) DO NOTHING`,
    [inboundMessageId]
  );
  // Count only messages actually accepted by Meta, not attempts, uploads or
  // queued requests. This also repairs the initial deferred audit after restart.
  await db.query(
    `WITH totals AS (
       SELECT
         COUNT(*) FILTER (WHERE media_kind='result')::integer result_total,
         COUNT(*) FILTER (WHERE media_kind='result' AND status='sent')::integer result_accepted,
         COUNT(*) FILTER (WHERE media_kind='promotion' AND status='sent')::integer promo_accepted,
         BOOL_OR(status IN ('pending','processing')) FILTER (WHERE media_kind='result') active,
         BOOL_OR(status IN ('failed','unknown','cancelled')) FILTER (WHERE media_kind='result') blocked
       FROM whatsapp_result_media_queue WHERE inbound_message_id=$1
     )
     UPDATE result_media_decisions d SET
       promotion_images_sent=GREATEST(d.promotion_images_sent,totals.promo_accepted),
       result_images_sent=GREATEST(d.result_images_sent,totals.result_accepted),
       status=CASE WHEN totals.result_total=0 THEN d.status
         WHEN totals.active THEN 'deferred'
         WHEN totals.result_accepted=totals.result_total THEN 'sent'
         WHEN totals.result_accepted>0 THEN 'partial'
         WHEN totals.blocked THEN 'failed'
         ELSE 'skipped' END,
       reason=CASE WHEN totals.result_total=0 THEN d.reason
         WHEN totals.active THEN 'awaiting_meta_free_billing'
         WHEN totals.result_accepted=totals.result_total THEN NULL
         WHEN totals.blocked THEN 'result_media_deferred_requires_review'
         ELSE 'duplicate_or_ineligible_result_media' END,
       updated_at=now()
     FROM totals WHERE d.inbound_message_id=$1`,
    [inboundMessageId]
  );
}

async function closeItem(row, status, reason, {
  messageId = null, db = pool, attention = false,
} = {}) {
  await db.query(
    `UPDATE whatsapp_result_media_queue
       SET status=$3,reason=$4,message_id=COALESCE($5,message_id),
           lease_token=NULL,claimed_at=NULL,updated_at=now()
       WHERE id=$1 AND lease_token=$2 AND status='processing'`,
    [row.id,row.lease_token,status,reason,messageId]
  );
  await reconcileAudit(row.inbound_message_id,db);
  if (attention) {
    await contactsRepo.setDeliveryAttention(
      row.contact_id,
      "Optional WhatsApp image was not sent. Please review this conversation."
    ).catch(error => console.error("[Result queue] Staff attention failed:",error));
  }
}

async function postpone(row, code, db = pool) {
  if (Date.now() - new Date(row.created_at).getTime() >= MAX_BILLING_WAIT_MS) {
    await closeItem(row,"cancelled","meta_free_billing_not_confirmed",{
      db, attention: true,
    });
    return;
  }
  await db.query(
    `UPDATE whatsapp_result_media_queue
       SET status='pending',attempts=attempts+1,reason=$3,
           next_attempt_at=now()+($4::integer*interval '1 millisecond'),
           claimed_at=NULL,lease_token=NULL,updated_at=now()
       WHERE id=$1 AND lease_token=$2 AND status='processing'`,
    [row.id,row.lease_token,code,RETRY_MS]
  );
}

async function eligibleForOptionalImage(row, db = pool) {
  if (!automatedRepliesEnabled()) return null;
  const contact = await contactsRepo.getContactById(row.contact_id);
  if (!contact || contact.channel !== "whatsapp" || contact.mode !== "ai" ||
      contact.needs_attention ||
      contact.whatsapp_opt_out_at || contact.whatsapp_marketing_opt_out_at) {
    return null;
  }
  if (aiReplyCancellation.hasPendingEcho(aiReplyCancellation.keyForContact(contact))) return null;
  const changed = await db.query(
    `SELECT EXISTS(
       SELECT 1 FROM messages newer
       JOIN messages original ON original.id=$2 AND original.contact_id=$1
       WHERE newer.contact_id=$1
         AND newer.created_at > original.created_at
         AND (newer.role='user' OR newer.sent_by_username IS NOT NULL)
     ) AS changed`,
    [row.contact_id,row.inbound_message_id]
  );
  if (changed.rows[0]?.changed !== false) return null;
  const owner = await getAiOwnedContact(contact,{
    channel:"whatsapp",from:contact.whatsapp_number,
    reason:"delayed strict-RM0 result image",
    inboundMessageId:row.inbound_message_id,
  });
  if (!owner || !(await contactsRepo.canSendAutomaticReviewMedia(owner.id))) return null;
  return owner;
}

async function claimNext(db = pool) {
  const result = await db.query(
    `WITH next AS (
       SELECT q.id FROM whatsapp_result_media_queue q
       WHERE q.status='pending' AND q.next_attempt_at<=now()
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_result_media_queue earlier
           WHERE earlier.inbound_message_id=q.inbound_message_id
             AND earlier.sequence_no<q.sequence_no
             AND earlier.status NOT IN ('sent','skipped')
         )
       ORDER BY q.next_attempt_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_result_media_queue q
     SET status='processing',lease_token=$1::uuid,claimed_at=now(),updated_at=now()
     FROM next WHERE q.id=next.id RETURNING q.*`,
    [crypto.randomUUID()]
  );
  return result.rows[0] || null;
}

async function sweepStaleAndBlocked(db = pool) {
  // A process could have reached Meta before crashing. NEVER resend a leased
  // item after restart: the result is unknown even when no WAMID is saved.
  const stale = await db.query(
    `UPDATE whatsapp_result_media_queue
       SET status='unknown',reason='worker_interrupted_provider_outcome_unknown',
         lease_token=NULL,claimed_at=NULL,updated_at=now()
       WHERE status='processing'
         AND claimed_at<now()-($1::integer*interval '1 millisecond')
       RETURNING contact_id,inbound_message_id`,
    [UNKNOWN_AFTER_MS]
  );
  const cancelled = await db.query(
    `UPDATE whatsapp_result_media_queue q
       SET status='cancelled',reason='earlier_image_not_sent',
         updated_at=now()
       WHERE status='pending' AND EXISTS (
         SELECT 1 FROM whatsapp_result_media_queue earlier
         WHERE earlier.inbound_message_id=q.inbound_message_id
           AND earlier.sequence_no<q.sequence_no
           AND earlier.status IN ('cancelled','failed','unknown')
       ) RETURNING q.inbound_message_id`
  );
  const all = [...stale.rows,...cancelled.rows];
  for (const inboundId of new Set(all.map(row=>row.inbound_message_id))) {
    await reconcileAudit(inboundId,db);
  }
  for (const row of stale.rows) {
    await contactsRepo.setDeliveryAttention(row.contact_id,
      "Optional WhatsApp image outcome is unknown after a restart. Check Meta before retrying."
    ).catch(error=>console.error("[Result queue] Staff alert failed:",error));
  }
}

async function runOne({
  db=pool,
  sender=channelMessaging.sendImageByUrl,
  eligibility=eligibleForOptionalImage,
}={}) {
  await sweepStaleAndBlocked(db);
  const row = await claimNext(db);
  if (!row) return false;
  let message = null;
  let providerResult = null;
  try {
    const contact = await eligibility(row,db);
    if (!contact) {
      await closeItem(row,"skipped","conversation_changed_or_staff_review",{db});
      return true;
    }
    if (await messagesRepo.wasMediaRecentlySent(row.contact_id,row.image_url) ||
        await messagesRepo.hasUnconfirmedMediaDelivery(row.contact_id,row.image_url)) {
      await closeItem(row,"skipped","duplicate_or_unconfirmed_media",{db});
      return true;
    }
    // Optional images are lower priority than live WhatsApp customer replies.
    // Never take the account-wide RM0 reservation while another inbound
    // conversation is waiting for its primary AI text reply.
    const liveReplies = await db.query(
      `SELECT EXISTS(
         SELECT 1 FROM inbound_processing_jobs j
         WHERE j.channel='whatsapp' AND j.contact_id<>$1
           AND j.status IN ('pending','processing')
           AND j.created_at>now()-interval '10 minutes'
       ) AS busy`,
      [row.contact_id]
    );
    if (liveReplies.rows[0]?.busy === true) {
      await postpone(row,"priority_to_live_customer_reply",db);
      return true;
    }
    // Read-only check BEFORE inserting a message or uploading image bytes.
    // Actual provider send still reserves the serial RM0 gate atomically.
    const ready = await zeroCost.preflightTemplate(contact.whatsapp_number,{database:db});
    if (!ready.allowed) {
      if (isTemporaryBillingBlock(ready)) {
        await postpone(row,ready.code,db);
      } else {
        await closeItem(row,"cancelled",ready.code || "billing_not_verified",{
          db,attention:true,
        });
      }
      return true;
    }
    const cancellationKey = aiReplyCancellation.keyForContact(contact);
    const cancellationEpoch = aiReplyCancellation.snapshot(cancellationKey);
    message = await conversationStore.appendMessageForContact(
      row.contact_id,"assistant",row.caption,null,null,row.image_url,
      null,{publish:false}
    );
    providerResult = await sender(contact,row.image_url,row.caption,{
      currentMessageId:message.id,
      preSendCheck:async()=>(
        aiReplyCancellation.safeToSend(cancellationKey,cancellationEpoch) &&
        Boolean(await eligibleForOptionalImage(row,db))
      ),
    });
    if (providerResult?.success && providerResult.wamid) {
      await messagesRepo.setWhatsappMessageId(message.id,providerResult.wamid);
      await closeItem(row,"sent",null,{messageId:message.id,db});
      realtimeEvents.publish("conversation_changed",{
        contactId:row.contact_id,messageId:message.id,reason:"message",
      });
      wake(SPACING_MS);
    } else if (providerResult?.cancelled ||
       (providerResult?.policyBlocked && isTemporaryBillingBlock(providerResult))) {
      const removed = await messagesRepo.deleteUnsentAssistantMessage(message.id);
      if (!removed) {
        await closeItem(row,"unknown","unsent_record_could_not_be_removed",{messageId:message.id,db,attention:true});
      } else if (providerResult?.cancelled) {
        await closeItem(row,"skipped","staff_cancelled_optional_image",{db});
      } else {
        await postpone(row,providerResult.policyCode,db);
      }
    } else if (providerResult?.ambiguous ||
      (providerResult?.success && !providerResult.wamid)) {
      // Never retry a possibly accepted send.
      await closeItem(row,"unknown","provider_outcome_uncertain",{messageId:message.id,db,attention:true});
    } else {
      await messagesRepo.setDeliveryStatusById(message.id,"failed",
        String(providerResult?.error || "Image was not accepted by WhatsApp"));
      await closeItem(row,"failed","provider_image_send_rejected",{messageId:message.id,db,attention:true});
    }
  } catch(error) {
    console.error("[Result queue] Unexpected result send failure:",error);
    // Once a message exists, the provider may have been called. Fail closed.
    await closeItem(row,message?"unknown":"cancelled",
      message?"send_interrupted_outcome_unknown":"result_media_worker_exception",{
        messageId:message?.id||null,db,attention:true,
      }).catch(e=>console.error("[Result queue] Could not store send state:",e));
  }
  return true;
}

async function nextDelay(db=pool) {
  const result = await db.query(
    `SELECT LEAST(
       (SELECT MIN(q.next_attempt_at)
        FROM whatsapp_result_media_queue q WHERE q.status='pending'
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_result_media_queue prior
            WHERE prior.inbound_message_id=q.inbound_message_id
              AND prior.sequence_no<q.sequence_no
              AND prior.status NOT IN ('sent','skipped')
          )),
       (SELECT MIN(claimed_at+interval '3 minutes')
         FROM whatsapp_result_media_queue WHERE status='processing')
     ) AS due_at`
  );
  // LEAST in PostgreSQL ignores NULL arguments.
  const due = result.rows[0]?.due_at;
  return due ? Math.max(250,new Date(due).getTime()-Date.now()) : IDLE_MS;
}

function wake(delay=0) { return worker?.wake(delay) || false; }

function start() {
  if (worker) return worker;
  worker=createAdaptiveWorkerTimer({
    run:async()=>{
      await runOne();
      return nextDelay();
    },
    delayForResult:delay=>delay,
    errorRetryDelayMs:10000,
    label:"Strict RM0 result image queue",
  });
  worker.start();
  return worker;
}

module.exports={
  enqueue,runOne,start,wake,isTemporaryBillingBlock,
  reconcileAudit,sweepStaleAndBlocked,MAX_BILLING_WAIT_MS,
};
