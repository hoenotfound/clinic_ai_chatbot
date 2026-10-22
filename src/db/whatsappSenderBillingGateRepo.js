"use strict";

// Durable, secondary-sender-only reservation ledger. Not integrated into the
// existing primary billing gate, provider dispatch or status workers.
// Reservations intentionally CANNOT be released here: later Phase 2 needs a
// separately reviewed pricing callback / Billing Hub reconciliation path.
const crypto = require("node:crypto");
const { pool } = require("./db");

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
   (m.whatsapp_template->>'billingAcknowledged'='true'
    AND EXISTS(
      SELECT 1 FROM whatsapp_manual_template_billing_claims claim
      WHERE claim.token_hash=m.whatsapp_template->>'billingReviewClaimHash'
        AND claim.contact_id=m.contact_id
        AND claim.template_name=m.whatsapp_template->>'name'
        AND claim.language_code=m.whatsapp_template->>'language'
        AND claim.claimed_at>=NOW()-INTERVAL '10 minutes'
    )) AS has_staff_template_billing_review,
   m.whatsapp_template->>'templateSignature' AS template_signature,
   m.whatsapp_template->>'billingReviewClaimHash' AS billing_review_claim_hash
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
  billableAuthorized = false, expectedTemplateSignature = null,
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
    // A caller boolean is not proof of staff approval. The exact saved
    // outbound message must carry a claimed one-time review, and the
    // canonical Meta template signature must match the approved request.
    if (billableAuthorized === true &&
        (owner.rows[0].has_staff_template_billing_review !== true ||
         !/^[a-f0-9]{64}$/.test(clean(expectedTemplateSignature)) ||
         owner.rows[0].template_signature !== expectedTemplateSignature)) {
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
      "SELECT state FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 AND owner_contact_id=$2 FOR UPDATE", [senderId,cid]
    );
    if (gate.rows?.length !== 1 || gate.rows[0].state !== "idle") {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_previous_send_unresolved");
    }
    // A late billable/failed receipt may arrive after an earlier reservation
    // was manually reconciled. A latched sender alarm overrides idle state.
    const alarm = await client.query(
      "SELECT 1 FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [senderId]
    );
    if (alarm.rows?.length) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_billing_sender_alarm");
    }
    const reservationId = crypto.randomUUID();
    await client.query(
      "INSERT INTO whatsapp_sender_billing_attempts " +
      "(reservation_id,sender_id,contact_id,message_id,billable_authorized,billing_authorization_source,billing_review_claim_hash) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7)",
      [reservationId,senderId,cid,mid,
        billableAuthorized === true,
        billableAuthorized === true ? "staff_template_billing_review" : null,
        billableAuthorized === true ? owner.rows[0].billing_review_claim_hash : null]
    );
    await client.query(
      "UPDATE whatsapp_sender_billing_gates SET " +
      "state='reserved',reservation_id=$2,contact_id=$3,message_id=$4,wamid=NULL," +
      "updated_at=NOW() WHERE sender_id=$1 AND owner_contact_id=$3 AND state='idle'",
      [senderId,reservationId,cid,mid]
    );
    await client.query("COMMIT"); inTransaction = false;
    return { reserved: true, sendAuthorized: false, reservationId };
  } catch {
    if (inTransaction && client) await client.query("ROLLBACK").catch(() => {});
    return deny("secondary_billing_database_unavailable");
  } finally {
    if (client) client.release();
  }
}

const OWNED_SECONDARY_RESERVATION_SQL = `
  SELECT g.sender_id,g.state,g.reservation_id,g.wamid
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
  reservationId, acceptedWamid = null,
}, { database = pool, env = process.env } = {}) {
  if (!gateEnabled(env)) return deny("secondary_billing_disabled");
  if (!/^[a-f0-9-]{36}$/i.test(clean(reservationId)) ||
      (acceptedWamid !== null && !/^wamid\./.test(clean(acceptedWamid)))) {
    return deny("secondary_billing_invalid_outcome");
  }
  let client;
  let transaction = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    transaction = true;
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
    const state = acceptedWamid ? "awaiting_pricing" : "unknown";
    await client.query(
      "UPDATE whatsapp_sender_billing_gates SET state=$2,wamid=$3,updated_at=NOW() " +
      "WHERE sender_id=$1 AND state='reserved'",
      [row.sender_id,state,acceptedWamid]
    );
    await client.query(
      "UPDATE whatsapp_sender_billing_attempts SET state=$2,wamid=$3,updated_at=NOW() " +
      "WHERE reservation_id=$1 AND state='reserved'",
      [reservationId,state,acceptedWamid]
    );
    await client.query("COMMIT"); transaction = false;
    return { recorded: true, sendAuthorized: false, state };
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
