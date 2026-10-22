"use strict";

// Phase 2D: staged manual settlement. No HTTP route, CLI, webhook worker, or
// outbound sender imports this service. A human Billing Hub attestation cannot
// be independently verified by Meta API; do not expose to untrusted callers.
const crypto = require("node:crypto");
const { pool } = require("../db/db");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function clean(v) { return typeof v === "string" ? v.trim() : ""; }
function deny(code) { return { reconciled:false, sendAuthorized:false, autoRetryAllowed:false, code }; }

function enabled(env) {
  return env.WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true" &&
    env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true" &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_WABA_ID)) &&
    clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) !== clean(env.WHATSAPP_PHONE_NUMBER_ID) &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(clean(env.WHATSAPP_SECONDARY_SENDER_KEY)) &&
    clean(env.WHATSAPP_SECONDARY_SENDER_KEY) !== clean(env.WHATSAPP_PRIMARY_SENDER_KEY);
}

const OWNED_SETTLEMENT_ATTEMPT_SQL = `
 SELECT a.reservation_id,a.sender_id,a.contact_id,a.message_id,a.wamid
 FROM whatsapp_sender_billing_attempts a
 JOIN whatsapp_sender_accounts sa ON sa.id=a.sender_id
 JOIN contacts c ON c.id=a.contact_id AND c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_conversations sc ON sc.contact_id=c.id
   AND sc.sender_id=sa.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages m ON m.id=a.message_id AND m.contact_id=c.id
   AND m.role='assistant'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
   AND mc.conversation_id=sc.id
 WHERE a.reservation_id=$1::uuid AND a.sender_id=$2
   AND a.state='awaiting_pricing' AND a.wamid IS NOT NULL
   AND (m.whatsapp_message_id IS NULL OR m.whatsapp_message_id=a.wamid)
 FOR UPDATE OF a
`;

const SETTLEMENT_RECEIPTS_SQL = `
 SELECT
   EXISTS(
     SELECT 1 FROM whatsapp_sender_status_receipts r
     WHERE r.reservation_id=$1::uuid AND r.sender_id=$2 AND r.matched=TRUE
       AND r.wamid=$3 AND r.fingerprint=$4
       AND r.meta_phone_number_id=$5 AND r.meta_account_id=$6
       AND r.pricing_billable=FALSE AND r.pricing_type='free_entry_point'
       AND r.delivery_status IN ('sent','delivered','read')
   ) AS matched_nonbillable,
   EXISTS(
     SELECT 1 FROM whatsapp_sender_status_receipts r
     WHERE r.reservation_id=$1::uuid AND r.sender_id=$2
       AND (r.pricing_billable=TRUE OR r.delivery_status='failed'
         OR (r.pricing_type IS NOT NULL
           AND r.pricing_type<>'free_entry_point')
         OR (r.pricing_billable IS NOT NULL AND r.pricing_billable<>FALSE))
   ) AS conflicting,
   EXISTS(
     SELECT 1 FROM whatsapp_sender_status_receipts r
     WHERE r.sender_id=$2 AND r.wamid_hash=$7 AND r.matched=FALSE
   ) AS mismatched_recipient
`;

async function reconcileVerifiedSecondaryNonbillable({
  reservationId, receiptFingerprint, reviewer, reason,
  billingHubConfirmed = false,
}, { database = pool, env = process.env } = {}) {
  if (!enabled(env)) return deny("secondary_reconciliation_disabled");
  const actor = clean(reviewer);
  const explanation = clean(reason);
  if (!UUID.test(clean(reservationId)) || !HASH.test(clean(receiptFingerprint)) ||
      actor.length < 3 || actor.length > 128 ||
      explanation.length < 12 || explanation.length > 1000 ||
      billingHubConfirmed !== true || typeof database?.connect !== "function") {
    return deny("secondary_reconciliation_review_required");
  }
  let client, tx = false;
  try {
    client = await database.connect();
    await client.query("BEGIN"); tx = true;
    const sender = await client.query(
      "SELECT id FROM whatsapp_sender_accounts " +
        "WHERE sender_key=$1 AND meta_phone_number_id=$2 " +
        "AND meta_account_id=$3 AND state='active'",
      [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]
    );
    if (sender.rows?.length !== 1) {
      await client.query("ROLLBACK"); tx = false;
      return deny("secondary_reconciliation_sender_unverified");
    }
    const senderId = sender.rows[0].id;
    // Lock sender-wide billing gate first, matching the receipt path's lock
    // order to serialize concurrent status callbacks and review.
    const gate = await client.query(
      "SELECT sender_id,reservation_id,state,wamid FROM whatsapp_sender_billing_gates " +
        "WHERE sender_id=$1 FOR UPDATE", [senderId]
    );
    const row = gate.rows?.[0];
    if (gate.rows?.length !== 1 || row.state !== "awaiting_pricing" ||
        String(row.reservation_id) !== reservationId ||
        !/^wamid\./.test(clean(row.wamid))) {
      await client.query("ROLLBACK"); tx = false;
      return deny("secondary_reconciliation_unresolved_or_stale");
    }
    const alarm = await client.query(
      "SELECT 1 FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [senderId]
    );
    if (alarm.rows?.length) {
      await client.query("ROLLBACK"); tx = false;
      return deny("secondary_reconciliation_sender_alarm");
    }
    const owner = await client.query(OWNED_SETTLEMENT_ATTEMPT_SQL,
      [reservationId,senderId]);
    const attempt = owner.rows?.[0];
    if (owner.rows?.length !== 1 || attempt.wamid !== row.wamid) {
      await client.query("ROLLBACK"); tx = false;
      return deny("secondary_reconciliation_attempt_mismatch");
    }
    const hash = crypto.createHash("sha256").update(row.wamid).digest("hex");
    const evidence = await client.query(SETTLEMENT_RECEIPTS_SQL, [
      reservationId,senderId,row.wamid,receiptFingerprint,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      env.WHATSAPP_SECONDARY_WABA_ID,hash
    ]);
    const check=evidence.rows?.[0];
    if (evidence.rows?.length !== 1 || check.matched_nonbillable !== true ||
        check.conflicting === true || check.mismatched_recipient === true) {
      await client.query("ROLLBACK"); tx = false;
      return deny("secondary_reconciliation_evidence_unverified");
    }
    const prior = await client.query(
      "SELECT 1 FROM whatsapp_sender_billing_reconciliations WHERE reservation_id=$1::uuid",
      [reservationId]
    );
    if (prior.rows?.length) {
      await client.query("ROLLBACK"); tx = false;
      return deny("secondary_reconciliation_already_recorded");
    }
    // Audit and state changes are atomic. This action does not send anything.
    await client.query(
      `INSERT INTO whatsapp_sender_billing_reconciliations
       (reservation_id,sender_id,provider_receipt_fingerprint,reviewer,reason,billing_hub_confirmed)
       VALUES($1,$2,$3,$4,$5,TRUE)`,
      [reservationId,senderId,receiptFingerprint,actor,explanation]
    );
    const settledAttempt = await client.query(
      "UPDATE whatsapp_sender_billing_attempts " +
      "SET state='reconciled',updated_at=NOW() " +
      "WHERE reservation_id=$1::uuid AND sender_id=$2 AND state='awaiting_pricing'",
      [reservationId,senderId]
    );
    const settledGate = await client.query(
      "UPDATE whatsapp_sender_billing_gates " +
      "SET state='idle',reservation_id=NULL,contact_id=NULL,message_id=NULL," +
      "wamid=NULL,updated_at=NOW() " +
      "WHERE sender_id=$1 AND reservation_id=$2::uuid AND state='awaiting_pricing'",
      [senderId,reservationId]
    );
    if (settledAttempt.rowCount !== 1 || settledGate.rowCount !== 1) {
      throw new Error("Secondary billing settlement lost its verified reservation");
    }
    await client.query("COMMIT"); tx = false;
    return { reconciled:true, sendAuthorized:false, autoRetryAllowed:false };
  } catch {
    if (tx && client) await client.query("ROLLBACK").catch(()=>{});
    return deny("secondary_reconciliation_database_unavailable");
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  OWNED_SETTLEMENT_ATTEMPT_SQL,
  SETTLEMENT_RECEIPTS_SQL,
  reconcileVerifiedSecondaryNonbillable,
};
