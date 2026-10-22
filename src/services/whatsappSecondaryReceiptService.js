"use strict";

// Phase 2C signed secondary delivery receipt ledger. NOT wired to the live
// webhook or any send/retry worker. Primary Neutro handler remains unchanged.
const crypto = require("node:crypto");
const { pool } = require("../db/db");

const DELIVERY_STATUSES = new Set(["sent", "delivered", "read", "failed"]);
const MAX_EVENTS = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

function clean(v) { return typeof v === "string" ? v.trim() : ""; }
function numeric(v) { return /^[0-9]+$/.test(clean(v)); }
function blocked(code) {
  return { accepted: false, sendAuthorized: false, autoRetryAllowed: false, code };
}
function receiptEnabled(env) {
  return env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true" &&
    env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED === "true" &&
    numeric(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) &&
    numeric(env.WHATSAPP_SECONDARY_WABA_ID) &&
    numeric(env.WHATSAPP_PHONE_NUMBER_ID) &&
    numeric(env.WHATSAPP_WABA_ID) &&
    clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) !== clean(env.WHATSAPP_PHONE_NUMBER_ID) &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(clean(env.WHATSAPP_SECONDARY_SENDER_KEY)) &&
    clean(env.WHATSAPP_SECONDARY_SENDER_KEY) !== clean(env.WHATSAPP_PRIMARY_SENDER_KEY);
}

function validateMetaSignature(rawBody, signatureHeader, secret) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 ||
      rawBody.length > MAX_BODY_BYTES ||
      !clean(secret) || !SIGNATURE_PATTERN.test(clean(signatureHeader))) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret)
    .update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(clean(signatureHeader)), Buffer.from(expected));
}

function digest(input) { return crypto.createHash("sha256").update(input).digest("hex"); }

function normalizedSignedEvents(rawBody, env) {
  let body;
  try { body = JSON.parse(rawBody.toString("utf8")); } catch { return null; }
  if (body?.object !== "whatsapp_business_account" ||
      !Array.isArray(body.entry) || body.entry.length < 1 ||
      body.entry.length > MAX_EVENTS) return null;
  const statuses = [];
  for (const entry of body.entry) {
    if (!entry || clean(entry.id) !== clean(env.WHATSAPP_SECONDARY_WABA_ID) ||
        !Array.isArray(entry.changes) || !entry.changes.length) return null;
    for (const change of entry.changes) {
      if (change?.field !== "messages" || !change.value ||
          Array.isArray(change.value) ||
          clean(change.value?.metadata?.phone_number_id) !==
            clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
          change.value.messages !== undefined ||
          !Array.isArray(change.value.statuses) ||
          !change.value.statuses.length) return null;
      for (const item of change.value.statuses) {
        if (!item || !/^wamid\.[A-Za-z0-9._:-]{1,450}$/.test(clean(item.id)) ||
            !DELIVERY_STATUSES.has(item.status) ||
            !/^[0-9]{8,15}$/.test(clean(item.recipient_id)) ||
            (item.timestamp !== undefined && !numeric(item.timestamp)) ||
            (item.pricing !== undefined && (item.pricing === null ||
              typeof item.pricing !== "object" || Array.isArray(item.pricing))) ||
            (item.pricing?.billable !== undefined &&
              typeof item.pricing.billable !== "boolean") ||
            (item.pricing?.type !== undefined &&
              !/^[a-z_]{1,64}$/.test(clean(item.pricing.type))) ||
            (item.pricing?.category !== undefined &&
              !/^[a-z_]{1,64}$/.test(clean(item.pricing.category)))) return null;
        const pricingType = clean(item.pricing?.type) ||
          (typeof item.pricing?.billable === "boolean" ? "unknown" : null);
        const pricingBillable = typeof item.pricing?.billable === "boolean" ?
          item.pricing.billable : null;
        const pricingCategory = clean(item.pricing?.category) || null;
        const event = {
          wamid: item.id,
          recipient: item.recipient_id,
          deliveryStatus: item.status,
          pricingType, pricingBillable, pricingCategory,
          phoneId: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
          accountId: env.WHATSAPP_SECONDARY_WABA_ID,
        };
        const signatureMaterial = [
          event.accountId, event.phoneId,
          event.wamid, event.recipient, event.deliveryStatus,
          event.pricingType, String(event.pricingBillable),
          event.pricingCategory, clean(item.timestamp),
          JSON.stringify(item.errors ?? null),
        ];
        event.fingerprint = digest(JSON.stringify(signatureMaterial));
        event.wamidHash = digest(event.wamid);
        statuses.push(event);
        if (statuses.length > MAX_EVENTS) return null;
      }
    }
  }
  return statuses.length ? statuses : null;
}

// The real /webhook body can contain primary and secondary entries in one
// HMAC-authenticated POST. Select only secondary statuses AFTER validating
// the HMAC over the entire original byte stream. Never reinterpret primary
// statuses as secondary, and reject mismatched account/phone combinations.
function normalizedSecondarySubsetEvents(rawBody, env) {
  let body;
  try { body = JSON.parse(rawBody.toString("utf8")); } catch { return null; }
  if (body?.object !== "whatsapp_business_account" ||
      !Array.isArray(body.entry) || body.entry.length > MAX_EVENTS) return null;
  const entry = [];
  for (const item of body.entry) {
    if (!item || !Array.isArray(item.changes)) return null;
    const changes = [];
    for (const change of item.changes) {
      const statuses = change?.value?.statuses;
      if (statuses === undefined) continue;
      const actualAccount = clean(item.id);
      const actualPhone = clean(change.value?.metadata?.phone_number_id);
      const secondaryAccount = clean(env.WHATSAPP_SECONDARY_WABA_ID);
      const secondaryPhone = clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
      // A single WABA can own multiple different business phone IDs. Never
      // confuse a primary-phone callback for an Ariel status in that case.
      if (actualAccount === clean(env.WHATSAPP_WABA_ID) &&
          actualPhone === clean(env.WHATSAPP_PHONE_NUMBER_ID)) continue;
      if (actualAccount !== secondaryAccount && actualPhone !== secondaryPhone) continue;
      if (actualAccount !== secondaryAccount || actualPhone !== secondaryPhone ||
          change.field !== "messages" || !Array.isArray(statuses) ||
          !statuses.length) return null;
      changes.push({
        field: "messages",
        value: { metadata: { phone_number_id: actualPhone }, statuses },
      });
    }
    if (changes.length) entry.push({ id: item.id, changes });
  }
  if (!entry.length) return [];
  return normalizedSignedEvents(
    Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry })), env
  );
}

const MATCH_SECONDARY_ATTEMPT_SQL = `
 SELECT a.reservation_id,a.sender_id,a.state AS attempt_state,
        g.state AS gate_state, g.reservation_id AS live_reservation_id
 FROM whatsapp_sender_billing_attempts a
 LEFT JOIN whatsapp_sender_billing_gates g
   ON g.sender_id=a.sender_id AND g.reservation_id=a.reservation_id
   AND g.contact_id=a.contact_id AND g.message_id=a.message_id
 JOIN whatsapp_sender_accounts sa ON sa.id=a.sender_id
 JOIN contacts c ON c.id=a.contact_id AND c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_conversations sc
   ON sc.contact_id=c.id AND sc.sender_id=sa.id AND sc.state='bound'
 JOIN messages m ON m.id=a.message_id AND m.contact_id=c.id
   AND m.role='assistant' AND (m.whatsapp_message_id IS NULL OR m.whatsapp_message_id=$1)
 JOIN whatsapp_sender_message_context mc
   ON mc.message_id=m.id AND mc.conversation_id=sc.id
 WHERE a.wamid=$1 AND a.state IN ('awaiting_pricing','unknown','reconciled')
   AND (g.reservation_id IS NULL OR
       (g.state IN ('awaiting_pricing','unknown') AND g.wamid=$1))
   AND sc.customer_wa_id=$2 AND c.whatsapp_number=$2
   AND sa.sender_key=$3 AND sa.meta_phone_number_id=$4
   AND sa.meta_account_id=$5 AND sa.state='active'
 FOR UPDATE OF a
`;

// A signed callback only records provider facts. It cannot release an
// unresolved gate or authorize a retry. Failed/billable callbacks move an
// accepted attempt to 'unknown' for manual billing review.
async function recordSignedSecondaryStatusBatch({
  rawBody, signatureHeader, subsetFromVerifiedWebhook = false,
}, { database = pool, env = process.env } = {}) {
  if (!receiptEnabled(env)) return blocked("secondary_receipts_disabled");
  if (!validateMetaSignature(rawBody, signatureHeader, env.WHATSAPP_APP_SECRET)) {
    return blocked("secondary_receipt_signature_invalid");
  }
  const events = subsetFromVerifiedWebhook ?
    normalizedSecondarySubsetEvents(rawBody, env) : normalizedSignedEvents(rawBody, env);
  if (!events) return blocked("secondary_receipt_batch_invalid");
  if (events.length === 0) return {
    accepted: true, matched: 0, unmatched: 0, replayed: 0, held: 0,
    sendAuthorized: false, autoRetryAllowed: false,
  };
  if (typeof database?.connect !== "function") return blocked("secondary_receipt_database_unavailable");

  let client;
  let transaction = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    transaction = true;
    const sender = await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 " +
      "AND meta_phone_number_id=$2 AND meta_account_id=$3 AND state='active'",
      [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]
    );
    if (sender.rows?.length !== 1) {
      await client.query("ROLLBACK"); transaction = false;
      return blocked("secondary_receipt_sender_not_verified");
    }
    const senderId = sender.rows[0].id;
    // Share the same sender gate row lock as reservation/reconciliation.
    // This prevents a callback racing the release of an earlier reservation.
    await client.query(
      "SELECT sender_id FROM whatsapp_sender_billing_gates " +
      "WHERE sender_id=$1 FOR UPDATE", [senderId]
    );
    let matched = 0;
    let unmatched = 0;
    let replayed = 0;
    let held = 0;
    for (const event of events) {
      const owner = await client.query(MATCH_SECONDARY_ATTEMPT_SQL, [
        event.wamid,event.recipient,env.WHATSAPP_SECONDARY_SENDER_KEY,
        event.phoneId,event.accountId,
      ]);
      const attempt = owner.rows?.length === 1 ? owner.rows[0] : null;
      const stored = await client.query(
        `INSERT INTO whatsapp_sender_status_receipts
          (fingerprint,sender_id,reservation_id,wamid,wamid_hash,
           delivery_status,pricing_type,pricing_billable,pricing_category,
           meta_phone_number_id,meta_account_id,matched)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint`,
        [event.fingerprint,senderId,attempt?.reservation_id || null,
          attempt ? event.wamid : null,event.wamidHash,event.deliveryStatus,
          event.pricingType,event.pricingBillable,event.pricingCategory,
          event.phoneId,event.accountId,Boolean(attempt)]
      );
      if (stored.rowCount === 0) {
        replayed++;
        continue;
      }
      if (!attempt) { unmatched++; continue; }
      matched++;
      // Even an accepted nonbillable receipt is not enough to clear the gate.
      // Later/conflicting callbacks must be reviewed against Meta Billing Hub.
      if (event.deliveryStatus === "failed" || event.pricingBillable === true) {
        // Latch even when this callback relates to an ALREADY settled send.
        // Subsequent new reservations must not ignore late contradictions.
        await client.query(
          `INSERT INTO whatsapp_sender_billing_alarms
             (sender_id,reservation_id,reason,latest_wamid_hash)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(sender_id) DO UPDATE SET
             observed_count=whatsapp_sender_billing_alarms.observed_count+1,
             last_seen_at=NOW(),latest_wamid_hash=EXCLUDED.latest_wamid_hash`,
          [attempt.sender_id,attempt.reservation_id,
            event.pricingBillable === true ? "provider_billable" : "provider_delivery_failed",
            event.wamidHash]
        );
        if (attempt.live_reservation_id) {
          await client.query(
            "UPDATE whatsapp_sender_billing_gates SET state='unknown',updated_at=NOW() " +
            "WHERE reservation_id=$1 AND sender_id=$2 AND state IN ('awaiting_pricing','unknown')",
            [attempt.reservation_id,attempt.sender_id]
          );
          await client.query(
            "UPDATE whatsapp_sender_billing_attempts SET state='unknown',updated_at=NOW() " +
            "WHERE reservation_id=$1 AND sender_id=$2 AND state IN ('awaiting_pricing','unknown')",
            [attempt.reservation_id,attempt.sender_id]
          );
        }
        held++;
      }
    }
    await client.query("COMMIT"); transaction = false;
    return {
      accepted: true, sendAuthorized: false, autoRetryAllowed: false,
      matched, unmatched, replayed, held,
    };
  } catch {
    if (transaction && client) await client.query("ROLLBACK").catch(() => {});
    return blocked("secondary_receipt_database_unavailable");
  } finally {
    if (client) client.release();
  }
}

// No secondary message can enter the existing Neutro retry worker. A new
// independent retry worker must first prove a verified non-delivery and
// sender-specific billing reconciliation; nothing here dispatches messages.
async function inspectSecondaryRetryHold(reservationId, {
  database = pool, env = process.env,
} = {}) {
  if (!receiptEnabled(env)) return blocked("secondary_receipts_disabled");
  if (!/^[0-9a-f-]{36}$/i.test(clean(reservationId))) {
    return blocked("secondary_retry_invalid_reservation");
  }
  try {
    const rows = (await database.query(
      `SELECT a.state AS attempt_state,g.state AS gate_state,
         EXISTS(SELECT 1 FROM whatsapp_sender_status_receipts r
           WHERE r.reservation_id=a.reservation_id AND r.matched
             AND (r.pricing_billable=true OR r.delivery_status='failed')) AS adverse_receipt
       FROM whatsapp_sender_billing_attempts a
       JOIN whatsapp_sender_billing_gates g
         ON g.sender_id=a.sender_id AND g.reservation_id=a.reservation_id
       JOIN whatsapp_sender_accounts sa ON sa.id=a.sender_id
       WHERE a.reservation_id=$1::uuid
         AND sa.sender_key=$2 AND sa.meta_phone_number_id=$3
         AND sa.meta_account_id=$4`,
      [reservationId,env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
    )).rows;
    if (rows?.length !== 1) return blocked("secondary_retry_not_found");
    return {
      canAutoRetry: false, sendAuthorized: false, reservationFound: true,
      code: rows[0].adverse_receipt ? "secondary_retry_adverse_receipt" :
        rows[0].gate_state === "unknown" || rows[0].attempt_state === "unknown" ?
          "secondary_retry_unknown_outcome" : "secondary_retry_waiting_pricing",
    };
  } catch {
    return blocked("secondary_retry_database_unavailable");
  }
}

module.exports = {
  validateMetaSignature,
  normalizedSignedEvents,
  normalizedSecondarySubsetEvents,
  MATCH_SECONDARY_ATTEMPT_SQL,
  recordSignedSecondaryStatusBatch,
  inspectSecondaryRetryHold,
};
