"use strict";

// Offline, operator-reviewed recovery for ONE privacy-erased secondary sender
// billing alarm. Deliberately NOT imported by server/router/worker or exposed
// through an HTTP endpoint. No transport, message, contact, or replay actions.
const { pool } = require("../db/db");

const HASH = /^[a-f0-9]{64}$/;
const ACTOR = /^[A-Za-z0-9._@-]{3,120}$/;
const OUTCOMES = new Set(["confirmed_sent", "confirmed_not_sent"]);
const CHARGES = new Set(["charge_accounted", "no_charge_verified"]);
const OUTBOUND_FLAGS = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED",
  "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
  "WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED",
  "WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED",
  "PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED",
  "WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED",
];

function deny(code) {
  return { released: false, sendAuthorized: false, retryAuthorized: false, code };
}

function enabled(env = process.env) {
  const key = String(env.WHATSAPP_SECONDARY_SENDER_KEY || "");
  const phone = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "");
  const account = String(env.WHATSAPP_SECONDARY_WABA_ID || "");
  return env.WHATSAPP_SECONDARY_ERASED_ALARM_RELEASE_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true" &&
    env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true" &&
    env.WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED !== "true" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(key) &&
    key !== env.WHATSAPP_PRIMARY_SENDER_KEY &&
    /^[0-9]{1,32}$/.test(phone) &&
    /^[0-9]{1,32}$/.test(account) &&
    phone !== env.WHATSAPP_PHONE_NUMBER_ID &&
    account !== env.WHATSAPP_WABA_ID &&
    env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID === phone &&
    env.WHATSAPP_SECONDARY_EXPECTED_WABA_ID === account &&
    !OUTBOUND_FLAGS.some(flag => env[flag] === "true");
}

function validateEvidence(input = {}) {
  const reservation = String(input.reservationSha256 || "");
  const appHash = String(input.businessAppEvidenceSha256 || "");
  const billingHash = String(input.metaBillingEvidenceSha256 || "");
  const reviewer = String(input.reviewer || "").trim();
  const approver = String(input.independentApprover || "").trim();
  const reason = String(input.reviewReason || "").trim();
  const outcome = input.outcome;
  const charge = input.chargeOutcome;
  if (input.operatorExplicitlyAuthorized !== true ||
      input.businessAppManuallyReviewed !== true ||
      input.metaBillingManuallyReviewed !== true ||
      !HASH.test(reservation) || !HASH.test(appHash) || !HASH.test(billingHash) ||
      reservation === appHash || reservation === billingHash || appHash === billingHash ||
      !ACTOR.test(reviewer) || !ACTOR.test(approver) ||
      reviewer.toLowerCase() === approver.toLowerCase() ||
      reason.length < 40 || reason.length > 800 ||
      !OUTCOMES.has(outcome) || !CHARGES.has(charge) ||
      (outcome === "confirmed_not_sent" && charge !== "no_charge_verified")) {
    return null;
  }
  return { reservation, appHash, billingHash, reviewer, approver, reason, outcome, charge };
}

async function releaseVerifiedErasedSecondaryAlarm(input, {
  database = pool,
  env = process.env,
} = {}) {
  if (!enabled(env)) return deny("secondary_erased_alarm_release_disabled");
  const evidence = validateEvidence(input);
  if (!evidence || typeof database?.connect !== "function") {
    return deny("secondary_erased_alarm_independent_evidence_required");
  }
  let client, inTransaction = false;
  try {
    client = await database.connect();
    await client.query("BEGIN");
    inTransaction = true;

    // Locks use the same first sender-row lock as normal billing reservation.
    // A concurrent new send or late status update must not race this decision.
    const sender = await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 " +
      "AND meta_phone_number_id=$2 AND meta_account_id=$3 AND state='active' FOR UPDATE",
      [env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env.WHATSAPP_SECONDARY_WABA_ID]
    );
    if (sender.rows?.length !== 1) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_erased_alarm_sender_mismatch");
    }
    const senderId = sender.rows[0].id;
    const alarms = await client.query(
      "SELECT reason,reservation_id,latest_wamid_hash,observed_count,first_seen_at " +
      "FROM whatsapp_sender_billing_alarms WHERE sender_id=$1 FOR UPDATE", [senderId]
    );
    const alarm = alarms.rows?.[0];
    // The SHA field holds the erased RESERVATION hash, not a provider WAMID.
    if (alarms.rows?.length !== 1 ||
        alarm.reason !== "purged_unresolved_reservation" ||
        alarm.reservation_id !== null ||
        alarm.latest_wamid_hash !== evidence.reservation ||
        Number(alarm.observed_count) !== 1) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_erased_alarm_not_exact_single_purge");
    }
    const erased = await client.query(
      "SELECT reservation_sha256,previous_state,staff_charge_approved,billable_receipt_seen " +
      "FROM whatsapp_sender_erased_billing_audit WHERE sender_id=$1 FOR SHARE", [senderId]
    );
    const audit = erased.rows?.[0];
    if (erased.rows?.length !== 1 ||
        audit.reservation_sha256 !== evidence.reservation ||
        audit.previous_state !== "unknown" ||
        audit.staff_charge_approved !== true ||
        audit.billable_receipt_seen !== false) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_erased_alarm_purge_audit_mismatch");
    }
    const current = await client.query(
      "SELECT " +
      "EXISTS(SELECT 1 FROM whatsapp_sender_billing_gates g " +
      "WHERE g.sender_id=$1 AND g.state<>'idle') AS busy_gate, " +
      "EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts a " +
      "WHERE a.sender_id=$1 AND a.state NOT IN ('reconciled','rejected')) AS open_attempt, " +
      "EXISTS(SELECT 1 FROM whatsapp_sender_status_receipts r " +
      "WHERE r.sender_id=$1 AND r.received_at >= $2) AS late_receipt, " +
      "EXISTS(SELECT 1 FROM whatsapp_sender_erased_alarm_resolutions x " +
      "WHERE x.sender_id=$1 AND x.reservation_sha256=$3) AS already_released",
      [senderId, alarm.first_seen_at, evidence.reservation]
    );
    const state = current.rows?.[0];
    if (current.rows?.length !== 1 || state.busy_gate ||
        state.open_attempt || state.late_receipt || state.already_released) {
      await client.query("ROLLBACK"); inTransaction = false;
      return deny("secondary_erased_alarm_new_evidence_or_open_attempt");
    }

    // This records only the hashes of external evidence, not erased customer
    // identifiers, chats, WAMIDs, phone numbers or billing screenshot content.
    await client.query(
      "INSERT INTO whatsapp_sender_erased_alarm_resolutions " +
      "(sender_id,reservation_sha256,outcome,charge_outcome," +
      "business_app_evidence_sha256,meta_billing_evidence_sha256," +
      "reviewer,independent_approver,review_reason) " +
      "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [senderId,evidence.reservation,evidence.outcome,evidence.charge,
        evidence.appHash,evidence.billingHash,evidence.reviewer,
        evidence.approver,evidence.reason]
    );
    const removed = await client.query(
      "DELETE FROM whatsapp_sender_billing_alarms WHERE sender_id=$1 " +
      "AND reason='purged_unresolved_reservation' AND reservation_id IS NULL " +
      "AND latest_wamid_hash=$2 AND observed_count=1 RETURNING sender_id",
      [senderId,evidence.reservation]
    );
    if (removed.rowCount !== 1) {
      throw new Error("Alarm changed during authorized reconciliation.");
    }
    await client.query("COMMIT"); inTransaction = false;
    // This release does NOT authorize a send, retry, message restoration or
    // any secondary automation mode. Those need separate explicit approvals.
    return { released: true, sendAuthorized: false, retryAuthorized: false };
  } catch {
    if (inTransaction && client) await client.query("ROLLBACK").catch(() => {});
    return deny("secondary_erased_alarm_database_or_concurrency_error");
  } finally {
    client?.release?.();
  }
}

module.exports = {
  OUTBOUND_FLAGS,
  enabled,
  validateEvidence,
  releaseVerifiedErasedSecondaryAlarm,
};
