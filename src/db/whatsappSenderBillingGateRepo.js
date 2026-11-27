"use strict";

// Durable, secondary-sender-only reservation ledger. Not integrated into the
// existing primary billing gate, provider dispatch or status workers.
// Reservations intentionally CANNOT be released here: later Phase 2 needs a
// separately reviewed pricing callback / Billing Hub reconciliation path.
const crypto = require("node:crypto");
const { pool } = require("./db");
const { applyStagedSecondaryReceipts } = require("./whatsappSenderEarlyReceiptRepo");
const {reviewedReservationIds,automaticFreshReplyEnabled,automaticUnknownFollowupSql,automaticFreshInboundSql}=require("../utils/whatsappSecondaryReviewedUnknownSend");
const { normalizeCustomerAddress, isBsuid } = require("../utils/whatsappCustomerIdentity");

function deny(code) { return { reserved: false, sendAuthorized: false, code }; }
function id(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function gateEnabled(env) {
  return env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED === "true" &&
    env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true" &&
    env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED === "true" &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_WABA_ID)) &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(clean(env.WHATSAPP_SECONDARY_SENDER_KEY)) &&
    clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) !== clean(env.WHATSAPP_PHONE_NUMBER_ID) &&
    clean(env.WHATSAPP_SECONDARY_SENDER_KEY) !== clean(env.WHATSAPP_PRIMARY_SENDER_KEY);
}

const OWNED_SECONDARY_OUTBOUND_SQL = `
 SELECT sa.id AS sender_id,
   COALESCE(c.whatsapp_last_customer_address,c.whatsapp_number) AS recipient_address,
   c.whatsapp_user_id,
   (m.whatsapp_template->>'billingAcknowledged'='true'
    AND EXISTS(
      SELECT 1 FROM whatsapp_manual_template_billing_claims claim
      WHERE claim.token_hash=m.whatsapp_template->>'billingReviewClaimHash'
        AND claim.contact_id=m.contact_id
        AND claim.template_name=m.whatsapp_template->>'name'
        AND claim.language_code=m.whatsapp_template->>'language'
        AND claim.claimed_at>=NOW()-INTERVAL '10 minutes'
    )) AS has_staff_template_billing_review,
   (m.is_automated_follow_up=TRUE
     AND m.sent_by_username IS NULL
     AND m.whatsapp_template->>'automatedSecondaryMarketingFollowup'='true'
     AND m.whatsapp_template->>'senderKey'=sa.sender_key
     AND m.whatsapp_template->>'slotHours' IN ('48','66','72','96','144')
     AND m.whatsapp_template->>'name' ~ '^[a-z0-9_]+$'
     AND EXISTS (
       SELECT 1 FROM whatsapp_sender_marketing_followup_attempts att
       JOIN whatsapp_sender_marketing_followup_rules rule
         ON rule.sender_id=att.sender_id AND rule.slot_hours=att.slot_hours
         AND rule.enabled=TRUE AND rule.operator_billing_approved=TRUE
       JOIN messages inbound ON inbound.id=att.anchor_message_id
         AND inbound.contact_id=m.contact_id
         AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
       JOIN whatsapp_sender_message_context inbound_mc
         ON inbound_mc.message_id=inbound.id
         AND inbound_mc.conversation_id=sc.id
       WHERE att.sender_id=sa.id AND att.contact_id=m.contact_id
         AND att.message_id=m.id AND att.status='claimed'
         AND att.slot_hours::text=m.whatsapp_template->>'slotHours'
         AND att.anchor_message_id::text=m.whatsapp_template->>'anchorMessageId'
         AND rule.template_name=m.whatsapp_template->>'name'
         AND rule.language_code=m.whatsapp_template->>'language'
         AND rule.template_signature=m.whatsapp_template->>'templateSignature'
         AND NOT EXISTS(
           SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
           WHERE h.sender_id=sa.id AND h.message_id=inbound.id
         )
     )
   ) AS has_automated_marketing_billing_approval,
   m.whatsapp_template->>'templateSignature' AS template_signature,
   m.whatsapp_template->>'billingReviewClaimHash' AS billing_review_claim_hash,
   (m.whatsapp_template IS NULL OR (
     m.is_automated_follow_up = TRUE
     AND m.whatsapp_template->>'automatedSecondaryFollowup' = 'true'
     AND m.whatsapp_template->>'senderKey' = sa.sender_key
     AND m.whatsapp_template->>'slotHours' IN ('2','6','20')
     AND m.whatsapp_template->>'anchorMessageId' ~ '^[0-9]+$'
     AND m.whatsapp_template->>'name' IS NULL
   ) OR (
     -- A queued AI graphic is freeform only when the one-shot claimed job
     -- matches sender, original signed inbound and this outbound row.
     m.is_automated_follow_up IS DISTINCT FROM TRUE
     AND m.sent_by_username IS NULL
     AND m.whatsapp_template->>'automatedSecondaryAiMedia' = 'true'
     AND m.whatsapp_template->>'senderKey' = sa.sender_key
     AND m.whatsapp_template->>'name' IS NULL
     AND m.whatsapp_template->>'anchorMessageId' ~ '^[0-9]+$'
     AND EXISTS (
       SELECT 1 FROM whatsapp_sender_ai_media_jobs job
       JOIN messages inbound ON inbound.id=job.inbound_message_id
         AND inbound.contact_id=m.contact_id
         AND inbound.role='user'
         AND inbound.whatsapp_message_id IS NOT NULL
       JOIN whatsapp_sender_message_context inbound_ctx
         ON inbound_ctx.message_id=inbound.id
         AND inbound_ctx.conversation_id=sc.id
       WHERE job.sender_id=sa.id AND job.contact_id=m.contact_id
         AND job.outbound_message_id=m.id
         AND job.state='claimed' AND job.expires_at>NOW()
         AND job.media_kind IN ('promotion','result')
         AND job.image_url=m.media_url
         AND m.whatsapp_template->>'anchorMessageId'=job.inbound_message_id::text
     )
   )) AS is_freeform_service
 FROM messages m
 JOIN contacts c ON c.id=m.contact_id AND c.channel='whatsapp'
 JOIN whatsapp_sender_conversations sc ON sc.contact_id=c.id
   AND sc.sender_id=c.whatsapp_sender_id AND sc.state='bound'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
   AND mc.conversation_id=sc.id
 JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id
 WHERE m.id=$2 AND c.id=$1 AND m.role='assistant'
   AND m.whatsapp_message_id IS NULL
   AND sa.state='active' AND sa.sender_key=$3
   AND sa.meta_phone_number_id=$4 AND sa.meta_account_id=$5
   AND sc.customer_wa_id=c.whatsapp_number
`;

async function reserveSecondaryBillingAttempt({
  contactId, messageId,
  billableAuthorized = false, expectedTemplateSignature = null, freshAiInboundMessageId = null,
}, {
  database = pool, env = process.env,
} = {}) {
  if (!gateEnabled(env)) return deny("secondary_billing_disabled");
  const cid = id(contactId);
  const mid = id(messageId);
  if (!cid || !mid || typeof database?.connect !== "function") {
    return deny("secondary_billing_invalid_context");
  }
  let client;
  let inTransaction = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    inTransaction = true;
    const owner = await client.query(OWNED_SECONDARY_OUTBOUND_SQL, [
      cid, mid, env.WHATSAPP_SECONDARY_SENDER_KEY,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env.WHATSAPP_SECONDARY_WABA_ID,
    ]);
    if (owner.rows?.length !== 1) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_sender_mismatch");
    }
    const senderId = owner.rows[0].sender_id;
    const recipientAddress = owner.rows[0].recipient_address;
    if (normalizeCustomerAddress(recipientAddress) !== recipientAddress ||
        (isBsuid(recipientAddress) &&
          owner.rows[0].whatsapp_user_id !== recipientAddress)) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_recipient_unverified");
    }
    // Templates require their one-time staff review; freeform messages use
    // the sender operator's explicit service-charge approval instead.
    // Neither an arbitrary caller boolean nor a 24h window proves RM0.
    const serviceApproved = billableAuthorized === true &&
      expectedTemplateSignature == null &&
      owner.rows[0].is_freeform_service === true &&
      env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED === "true";
    const templateApproved = billableAuthorized === true &&
      owner.rows[0].has_staff_template_billing_review === true &&
      /^[a-f0-9]{64}$/.test(clean(expectedTemplateSignature)) &&
      owner.rows[0].template_signature === expectedTemplateSignature;
    const automatedMarketingApproved = billableAuthorized === true &&
      owner.rows[0].has_automated_marketing_billing_approval === true &&
      env.WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED === "true" &&
      env.WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED === "true" &&
      env.WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED === "true" &&
      /^[a-f0-9]{64}$/.test(clean(expectedTemplateSignature)) &&
      owner.rows[0].template_signature === expectedTemplateSignature;
    if (billableAuthorized === true && !serviceApproved && !templateApproved && !automatedMarketingApproved) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_template_review_unverified");
    }
    // Serialize global sender billing alarms with per-contact reservations.
    // Never keep the sender row lock across the Meta provider request.
    await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE id=$1 FOR UPDATE",
      [senderId]
    );
    // Different Ariel contacts now have independent unresolved attempts.
    await client.query(
      "INSERT INTO whatsapp_sender_billing_gates(sender_id,owner_contact_id) " +
      "VALUES($1,$2) ON CONFLICT(sender_id,owner_contact_id) DO NOTHING",
      [senderId,cid]
    );
    const gate = await client.query(
      "SELECT state,reservation_id,message_id FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 AND owner_contact_id=$2 FOR UPDATE", [senderId,cid]
    );
    if (gate.rows?.length !== 1) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_previous_send_unresolved");
    }
    // A latched sender-wide alarm always overrides a per-contact gate, even
    // when an earlier failed/uncertain send is eligible for a *new* send.
    const alarm = await client.query(
      "SELECT 1 FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [senderId]
    );
    if (alarm.rows?.length) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_sender_alarm");
    }
    if (gate.rows[0].state !== "idle") {
      // Neutro secondary: a *signed, sender-matched final FAILED receipt*
      // is enough to permit a DIFFERENT fresh message, without two human
      // reviewers or a manually curated UUID allowlist. This does not assert
      // the failed send was free, and never retries the historical message.
      // An uncertain automated service follow-up may allow a distinct new
      // customer-initiated AI text under existing service-charge approval.
      // Other unconfirmed/no-WAMID attempts still require explicit review.
      // Reserved, awaiting_pricing and sender-wide alarms always block.
      if (gate.rows[0].state !== "unknown" ||
          env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary") {
        await client.query("ROLLBACK"); inTransaction = false;
        return deny("secondary_billing_previous_send_unresolved");
      }
      const manuallyReviewed =
        env.WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED === "true" &&
        reviewedReservationIds(env).includes(
          String(gate.rows[0].reservation_id||"").toLowerCase());
      const autoEnabled=automaticFreshReplyEnabled(env) && serviceApproved &&
        id(freshAiInboundMessageId)!=null;
      const autoProof=autoEnabled ? `(
        ${automaticUnknownFollowupSql("a","old")}
        AND ${automaticFreshInboundSql("a","old","$8")}
        AND EXISTS (
          SELECT 1 FROM messages fresh
          JOIN messages inbound ON inbound.id=$8 AND inbound.contact_id=fresh.contact_id
          WHERE fresh.id=$7 AND fresh.contact_id=a.contact_id
            AND fresh.role='assistant' AND fresh.sent_by_username IS NULL
            AND fresh.is_automated_follow_up IS DISTINCT FROM TRUE
            AND fresh.whatsapp_template IS NULL AND fresh.whatsapp_interactive IS NULL
            AND fresh.media_url IS NULL AND fresh.media_key IS NULL
            AND fresh.media_base64 IS NULL AND fresh.media_mime_type IS NULL
            AND fresh.whatsapp_message_id IS NULL AND fresh.whatsapp_accepted_at IS NULL
            AND fresh.created_at>=inbound.created_at
            AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts prev WHERE prev.message_id=fresh.id)
            AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e WHERE e.message_id=fresh.id)
        )
      )` : "FALSE";
      const proof = await client.query(`
        SELECT a.reservation_id,
          ${autoProof} AS automatic_fresh_reply,
          EXISTS (
            SELECT 1 FROM whatsapp_sender_unknown_gate_inbox_reviews review
            JOIN messages fresh ON fresh.id=$7 AND fresh.contact_id=a.contact_id
              AND fresh.role='assistant'
              AND (fresh.sent_by_username=review.actor OR (
                $8::integer IS NOT NULL AND fresh.sent_by_username IS NULL
                AND fresh.media_url IS NULL AND fresh.media_key IS NULL
                AND fresh.media_base64 IS NULL AND fresh.media_mime_type IS NULL
                AND EXISTS (
                  SELECT 1 FROM contacts ai_contact
                  JOIN whatsapp_sender_conversations ai_sc
                    ON ai_sc.contact_id=ai_contact.id AND ai_sc.sender_id=a.sender_id
                    AND ai_sc.state='bound' AND ai_sc.customer_wa_id=ai_contact.whatsapp_number
                  JOIN messages inbound ON inbound.id=$8 AND inbound.contact_id=ai_contact.id
                  JOIN whatsapp_sender_message_context inbound_ctx
                    ON inbound_ctx.message_id=inbound.id AND inbound_ctx.conversation_id=ai_sc.id
                  WHERE ai_contact.id=a.contact_id AND ai_contact.whatsapp_sender_id=a.sender_id
                    AND ai_contact.mode='ai' AND ai_contact.takeover_by IS NULL
                    AND ai_contact.whatsapp_opt_out_at IS NULL
                    AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
                    AND inbound.created_at>=review.reviewed_at
                    AND inbound.source_created_at>=review.reviewed_at
                    AND inbound.source_created_at>old.created_at
                    AND inbound.source_created_at>NOW()-INTERVAL '24 hours'
                    AND inbound.created_at<=fresh.created_at
                    AND inbound.is_forwarded IS DISTINCT FROM TRUE
                    AND NULLIF(BTRIM(COALESCE(inbound.content,'')),'') IS NOT NULL
                    AND inbound.content NOT LIKE '📎 [%'
                    AND NOT EXISTS(SELECT 1 FROM ai_review_items pending
                      WHERE pending.contact_id=ai_contact.id AND pending.status='pending')
                    AND NOT EXISTS(SELECT 1 FROM messages newer
                      WHERE newer.contact_id=ai_contact.id AND newer.role='user'
                        AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id))
                )
              ))
              AND fresh.is_automated_follow_up IS DISTINCT FROM TRUE
              AND fresh.whatsapp_template IS NULL
              AND fresh.created_at>=review.reviewed_at
              AND fresh.whatsapp_message_id IS NULL
              AND fresh.whatsapp_accepted_at IS NULL
            WHERE review.reservation_id=a.reservation_id AND review.sender_id=a.sender_id
              AND review.contact_id=a.contact_id AND review.old_message_id=a.message_id
              AND review.non_delivery_checked=TRUE AND review.billing_no_charge_checked=TRUE
              AND review.reviewed_at>=NOW()-INTERVAL '24 hours'
              AND old.whatsapp_accepted_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e WHERE e.message_id=old.id)
              AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts prior_fresh WHERE prior_fresh.message_id=fresh.id)
              AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e WHERE e.message_id=fresh.id)
          ) AS inbox_reviewed,
          CASE WHEN a.wamid IS NULL AND old.whatsapp_message_id IS NULL
              AND old.delivery_status='unknown'
              AND NOT EXISTS (
                SELECT 1 FROM whatsapp_sender_status_receipts r
                WHERE r.sender_id=a.sender_id
                  AND r.reservation_id=a.reservation_id
              ) THEN 'unconfirmed_no_wamid'
            WHEN a.wamid IS NOT NULL AND old.whatsapp_message_id=a.wamid
              AND old.delivery_status='failed'
              AND EXISTS (
                SELECT 1 FROM whatsapp_sender_status_receipts r
                WHERE r.sender_id=a.sender_id
                  AND r.reservation_id=a.reservation_id
                  AND r.matched=TRUE AND r.wamid=a.wamid
                  AND r.meta_phone_number_id=$5
                  AND r.meta_account_id=$6
                  AND r.delivery_status='failed'
              ) THEN 'signed_failed'
            ELSE NULL END AS release_basis
        FROM whatsapp_sender_billing_attempts a
        JOIN messages old ON old.id=a.message_id
          AND old.contact_id=a.contact_id AND old.role='assistant'
        JOIN whatsapp_sender_billing_gates g
          ON g.sender_id=a.sender_id AND g.owner_contact_id=a.contact_id
          AND g.reservation_id=a.reservation_id
          AND g.message_id=a.message_id AND g.state='unknown'
        WHERE a.reservation_id=$1::uuid AND a.sender_id=$2
          AND a.contact_id=$3 AND a.message_id=$4
          AND a.state='unknown' AND a.message_id<>$7
          AND (g.updated_at<=NOW()-INTERVAL '30 minutes' OR ${autoProof})
          -- One reviewed bypass maximum per contact in a rolling 30 days.
          -- The old reservation's primary-key audit already blocks replay.
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_unknown_gate_new_sends prior
            WHERE prior.sender_id=a.sender_id AND prior.contact_id=a.contact_id
              AND prior.reopened_at>NOW()-INTERVAL '30 days'
          )
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_sender_status_receipts r
            WHERE r.sender_id=a.sender_id AND r.reservation_id=a.reservation_id
              AND (r.delivery_status IN ('delivered','read')
                   OR r.pricing_billable=TRUE)
          )
      `,[gate.rows[0].reservation_id,senderId,cid,gate.rows[0].message_id,
         env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
         env.WHATSAPP_SECONDARY_WABA_ID,mid,serviceApproved ? id(freshAiInboundMessageId) : null]);
      const approved = proof.rows?.[0];
      if (!approved?.release_basis) {
        await client.query("ROLLBACK"); inTransaction = false;
        return deny("secondary_billing_previous_send_unresolved");
      }
      if (approved.release_basis !== "signed_failed" && !manuallyReviewed && approved.inbox_reviewed !== true && approved.automatic_fresh_reply !== true) {
        await client.query("ROLLBACK"); inTransaction = false;
        // No-WAMID remains a possible provider send; the operator bypass
        // setting must be enabled before any manual UUID review is relevant.
        return deny(
          env.WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED === "true"
            ? "secondary_billing_unknown_hold_not_reviewed"
            : "secondary_billing_previous_send_unresolved"
        );
      }
      // Preserve a separate, permanent record of which original UNKNOWN gate
      // was bypassed for which new message. Both writes occur in the same
      // transaction under the sender and contact locks.
      await client.query(
        "INSERT INTO whatsapp_sender_unknown_gate_new_sends "+
        "(old_reservation_id,sender_id,contact_id,old_message_id,new_message_id,basis) "+
        "VALUES($1,$2,$3,$4,$5,$6)",
        [approved.reservation_id,senderId,cid,gate.rows[0].message_id,mid,
         approved.release_basis]
      );
      if (approved.automatic_fresh_reply === true) {
        console.info("[Secondary WhatsApp fresh reply after unknown follow-up]", JSON.stringify({
          oldMessageId:gate.rows[0].message_id,newMessageId:mid,
          inboundMessageId:id(freshAiInboundMessageId),oldChargeUnverified:true,
        }));
      }
      const reopened = await client.query(
        "UPDATE whatsapp_sender_billing_gates SET "+
        "state='idle',reservation_id=NULL,contact_id=NULL,message_id=NULL,"+
        "wamid=NULL,updated_at=NOW() "+
        "WHERE sender_id=$1 AND owner_contact_id=$2 "+
        "AND state='unknown' AND reservation_id=$3::uuid",
        [senderId,cid,approved.reservation_id]
      );
      if (reopened.rowCount !== 1) {
        throw Error("Secondary UNKNOWN gate changed during new-send review");
      }
    }
    const reservationId = crypto.randomUUID();
    await client.query(
      "INSERT INTO whatsapp_sender_billing_attempts " +
      "(reservation_id,sender_id,contact_id,message_id,billable_authorized,billing_authorization_source,billing_review_claim_hash,recipient_address) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [reservationId,senderId,cid,mid,
        billableAuthorized === true,
        serviceApproved ? "operator_acknowledged_service" :
          templateApproved ? "staff_template_billing_review" :
            automatedMarketingApproved ? "operator_approved_marketing_template" : null,
        templateApproved ? owner.rows[0].billing_review_claim_hash : null,
        recipientAddress]
    );
    await client.query(
      "UPDATE whatsapp_sender_billing_gates SET " +
      "state='reserved',reservation_id=$2,contact_id=$3,message_id=$4,wamid=NULL," +
      "updated_at=NOW() WHERE sender_id=$1 AND owner_contact_id=$3 AND state='idle'",
      [senderId,reservationId,cid,mid]
    );
    await client.query("COMMIT"); inTransaction = false;
    return { reserved: true, sendAuthorized: false, reservationId,
      recipientAddress };
  } catch {
    if (inTransaction && client) await client.query("ROLLBACK").catch(() => {});
    return deny("secondary_billing_database_unavailable");
  } finally {
    if (client) client.release();
  }
}

const OWNED_SECONDARY_RESERVATION_SQL = `
  SELECT g.sender_id,g.owner_contact_id,g.state,g.reservation_id,g.wamid,a.message_id
  FROM whatsapp_sender_billing_gates g
  JOIN whatsapp_sender_accounts sa ON sa.id=g.sender_id
  JOIN whatsapp_sender_billing_attempts a ON a.reservation_id=g.reservation_id
    AND a.sender_id=g.sender_id AND a.contact_id=g.contact_id
    AND a.contact_id=g.owner_contact_id
  WHERE g.reservation_id=$1::uuid
    AND sa.sender_key=$2 AND sa.meta_phone_number_id=$3
    AND sa.meta_account_id=$4 AND sa.state='active'
  FOR UPDATE OF g
`;

// This records Meta HTTP acceptance, NOT verified delivery/billing. No
// customer-send permission and no gate reset are granted by this function.
async function recordSecondaryProviderOutcome({
  reservationId, acceptedWamid = null, definitivelyRejected = false,
}, { database = pool, env = process.env } = {}) {
  if (!gateEnabled(env)) return deny("secondary_billing_disabled");
  if (!/^[a-f0-9-]{36}$/i.test(clean(reservationId)) ||
      (acceptedWamid !== null && !/^wamid\./.test(clean(acceptedWamid))) ||
      (definitivelyRejected === true && acceptedWamid !== null)) {
    return deny("secondary_billing_invalid_outcome");
  }
  let client;
  let transaction = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    transaction = true;
    // Signed status ingress takes this sender lock before the customer gate.
    // Preserve that lock order so a racing callback cannot be lost or deadlock.
    const senderLock = await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 " +
      "AND meta_phone_number_id=$2 AND meta_account_id=$3 AND state='active' FOR UPDATE",
      [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]
    );
    if (senderLock.rowCount !== 1) {
      await client.query("ROLLBACK"); transaction = false;
      return deny("secondary_billing_sender_mismatch");
    }
    const result = await client.query(OWNED_SECONDARY_RESERVATION_SQL, [
      reservationId,env.WHATSAPP_SECONDARY_SENDER_KEY,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
    ]);
    const row = result.rows?.[0];
    if (result.rows?.length !== 1 ||
        (row.state !== "reserved" &&
          !(row.state === "awaiting_pricing" && acceptedWamid && row.wamid === acceptedWamid))) {
      await client.query("ROLLBACK"); transaction = false;
      return deny("secondary_billing_reservation_not_found");
    }
    if (row.state === "awaiting_pricing") {
      await client.query("COMMIT"); transaction = false;
      return { recorded: true, sendAuthorized: false, state: "awaiting_pricing" };
    }
    const state = definitivelyRejected === true ? "rejected" :
      acceptedWamid ? "awaiting_pricing" : "unknown";
    // A sender may have many simultaneous customer gates. Never mutate
    // another contact's reservation when this provider request completes.
    const gateUpdated = await client.query(
      "UPDATE whatsapp_sender_billing_gates SET " +
      "state=CASE WHEN $2='rejected' THEN 'idle' ELSE $2 END," +
      "reservation_id=CASE WHEN $2='rejected' THEN NULL ELSE reservation_id END," +
      "contact_id=CASE WHEN $2='rejected' THEN NULL ELSE contact_id END," +
      "message_id=CASE WHEN $2='rejected' THEN NULL ELSE message_id END," +
      "wamid=CASE WHEN $2='rejected' THEN NULL ELSE $3 END,updated_at=NOW() " +
      "WHERE sender_id=$1 AND owner_contact_id=$4 " +
      "AND reservation_id=$5::uuid AND state='reserved'",
      [row.sender_id,state,acceptedWamid,row.owner_contact_id,reservationId]
    );
    const attemptUpdated = await client.query(
      "UPDATE whatsapp_sender_billing_attempts SET state=$2,wamid=$3,updated_at=NOW() " +
      "WHERE reservation_id=$1::uuid AND sender_id=$4 AND contact_id=$5 AND state='reserved'",
      [reservationId,state,acceptedWamid,row.sender_id,row.owner_contact_id]
    );
    if (gateUpdated.rowCount !== 1 || attemptUpdated.rowCount !== 1) {
      await client.query("ROLLBACK"); transaction = false;
      return deny("secondary_billing_outcome_ownership_changed");
    }
    // Status may have arrived just before the HTTP response/WAMID was
    // persisted. Promote the original HMAC-verified receipt atomically,
    // requiring exact sender + WAMID + recipient proof. No second webhook
    // callback or automatic retry is needed.
    const staged = acceptedWamid ? await applyStagedSecondaryReceipts({
      client, senderId: row.sender_id, contactId: row.owner_contact_id,
      messageId: row.message_id, reservationId, acceptedWamid, env,
    }) : null;
    await client.query("COMMIT"); transaction = false;
    return {
      recorded:true,sendAuthorized:false,
      state: staged?.autoReconciled ? "reconciled" :
        staged?.held ? "unknown" : state,
      ...(staged ? { stagedReceiptsMatched:staged.matched,
        stagedAutoReconciled:staged.autoReconciled } : {}),
    };
  } catch {
    if (transaction && client) await client.query("ROLLBACK").catch(() => {});
    return deny("secondary_billing_database_unavailable");
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  OWNED_SECONDARY_OUTBOUND_SQL,
  OWNED_SECONDARY_RESERVATION_SQL,
  reserveSecondaryBillingAttempt,
  recordSecondaryProviderOutcome,
};