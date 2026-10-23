"use strict";

// Replay HMAC-verified Ariel receipts staged before provider acceptance.
// The signed webhook ingest stores only SHA256 identifiers. A staged receipt
// is never attributed until BOTH the exact WAMID and recipient hash match.
const crypto = require("node:crypto");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

async function applyStagedSecondaryReceipts({
  client, senderId, contactId, messageId, reservationId, acceptedWamid, env,
}) {
  const owner = await client.query(
    "SELECT whatsapp_number FROM contacts WHERE id=$1 AND whatsapp_sender_id=$2 AND channel='whatsapp'",
    [contactId, senderId]
  );
  if (owner.rowCount !== 1 || !/^[0-9]{8,15}$/.test(owner.rows[0].whatsapp_number)) {
    throw new Error("Early receipt owner cannot be verified");
  }
  // Even a valid Meta callback cannot be adopted by a different reservation.
  const duplicate = await client.query(
    "SELECT 1 FROM whatsapp_sender_billing_attempts WHERE sender_id=$1 AND wamid=$2 AND reservation_id<>$3::uuid",
    [senderId,acceptedWamid,reservationId]
  );
  if (duplicate.rowCount) throw new Error("Provider WAMID already belongs to another reservation");
  const pending = await client.query(
    `SELECT fingerprint,recipient_hash,delivery_status,pricing_type,
            pricing_billable,pricing_category
       FROM whatsapp_sender_status_receipts
      WHERE sender_id=$1 AND wamid_hash=$2 AND matched=FALSE
        AND meta_phone_number_id=$3 AND meta_account_id=$4
      ORDER BY received_at,fingerprint FOR UPDATE`,
    [senderId,hash(acceptedWamid),env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      env.WHATSAPP_SECONDARY_WABA_ID]
  );
  if (!pending.rowCount) return { matched:0, autoReconciled:false, held:false };
  const expectedRecipient = hash(owner.rows[0].whatsapp_number);
  const wrongRecipient = pending.rows.some(r=>r.recipient_hash !== expectedRecipient);
  const verified = pending.rows.filter(r=>r.recipient_hash === expectedRecipient);
  if (!verified.length) return { matched:0, autoReconciled:false, held:false };

  for (const receipt of verified) {
    const promoted = await client.query(
      `UPDATE whatsapp_sender_status_receipts
          SET reservation_id=$2::uuid,wamid=$3,matched=TRUE
        WHERE fingerprint=$1 AND sender_id=$4 AND matched=FALSE
          AND recipient_hash=$5 RETURNING fingerprint`,
      [receipt.fingerprint,reservationId,acceptedWamid,senderId,expectedRecipient]
    );
    if (promoted.rowCount !== 1) throw new Error("Early receipt promotion lost identity");
    const delivery = await client.query(
      `UPDATE messages SET
          whatsapp_message_id=COALESCE(whatsapp_message_id,$3),
          whatsapp_accepted_at=COALESCE(whatsapp_accepted_at,clock_timestamp()),
          delivery_status=CASE
            WHEN $4='read' THEN 'read'
            WHEN $4='delivered' AND delivery_status IS DISTINCT FROM 'read' THEN 'delivered'
            WHEN $4='sent' AND COALESCE(delivery_status,'') NOT IN('read','delivered','failed') THEN 'sent'
            WHEN $4='failed' AND COALESCE(delivery_status,'') NOT IN('read','delivered') THEN 'failed'
            ELSE delivery_status END,
          delivery_error=CASE
            WHEN $4='failed' AND COALESCE(delivery_status,'') NOT IN('read','delivered')
              THEN 'Verified Meta delivery failure; staff review required.'
            WHEN $4 IN('read','delivered','sent') THEN NULL
            ELSE delivery_error END
        WHERE id=$1 AND contact_id=$2 AND role='assistant'
          AND (whatsapp_message_id IS NULL OR whatsapp_message_id=$3)
        RETURNING id`,
      [messageId,contactId,acceptedWamid,receipt.delivery_status]
    );
    if (delivery.rowCount !== 1) throw new Error("Early receipt message ownership mismatch");
  }

  const failed = verified.some(r=>r.delivery_status==='failed');
  const priced = verified.filter(r=>r.pricing_billable !== null || r.pricing_type !== null);
  const paid = priced.some(r=>r.pricing_billable === true);
  const billingInfo = (await client.query(
    "SELECT billable_authorized,billing_authorization_source FROM whatsapp_sender_billing_attempts WHERE reservation_id=$1::uuid AND sender_id=$2",
    [reservationId,senderId]
  )).rows[0];
  const operatorServiceCharge = paid &&
    billingInfo?.billable_authorized === true &&
    billingInfo.billing_authorization_source === 'operator_acknowledged_service' &&
    priced.every(r=>r.pricing_billable===true && r.pricing_type==='regular' &&
      r.pricing_category==='service');
  const paidPermitted = paid && billingInfo?.billable_authorized===true && (
    (billingInfo.billing_authorization_source==='staff_template_billing_review' &&
     env.WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED==='true' &&
     priced.every(r=>r.pricing_billable===true && r.pricing_type==='regular' &&
       ['service','utility','marketing'].includes(r.pricing_category))) ||
    (operatorServiceCharge &&
     env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED==='true' &&
     env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==='true')
  );
  const unexpectedPaid = paid && !paidPermitted;

  // An operator-approved service charge without auto-reconciliation requires
  // manual review for this contact, not a false sender-wide billing incident.
  if (paid && unexpectedPaid && !operatorServiceCharge) {
    await client.query(
      `INSERT INTO whatsapp_sender_billing_alarms
          (sender_id,reservation_id,reason,latest_wamid_hash)
        VALUES($1,$2::uuid,'provider_billable',$3)
        ON CONFLICT(sender_id) DO UPDATE SET
          observed_count=whatsapp_sender_billing_alarms.observed_count+1,
          last_seen_at=NOW(),latest_wamid_hash=EXCLUDED.latest_wamid_hash`,
      [senderId,reservationId,hash(acceptedWamid)]
    );
  }
  if (failed || unexpectedPaid) {
    await client.query(
      "UPDATE whatsapp_sender_billing_gates SET state='unknown',updated_at=NOW() WHERE sender_id=$1 AND owner_contact_id=$2 AND reservation_id=$3::uuid AND state='awaiting_pricing'",
      [senderId,contactId,reservationId]
    );
    await client.query(
      "UPDATE whatsapp_sender_billing_attempts SET state='unknown',updated_at=NOW() WHERE sender_id=$1 AND contact_id=$2 AND reservation_id=$3::uuid AND state='awaiting_pricing'",
      [senderId,contactId,reservationId]
    );
    return { matched:verified.length,autoReconciled:false,held:true };
  }

  const free = priced.length > 0 && priced.every(r=>
    r.pricing_billable === false &&
    (r.pricing_type === 'free_entry_point' ||
      (r.pricing_type === 'free_customer_service' && r.pricing_category === 'service'))
  );
  const consistent = paid ?
    priced.every(r=>r.pricing_billable===true && r.pricing_type==='regular' &&
      r.pricing_category===priced[0].pricing_category) :
    free && priced.every(r=>r.pricing_type===priced[0].pricing_type);
  const permitted = !wrongRecipient && !failed && consistent &&
    ((paid && !unexpectedPaid) ||
      (free && env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === 'true'));
  if (!permitted) return {matched:verified.length,autoReconciled:false,held:false};
  const alarms = await client.query(
    "SELECT 1 FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
    [senderId]
  );
  if (alarms.rowCount) return {matched:verified.length,autoReconciled:false,held:true};

  const evidence = priced[0];
  const audit = await client.query(
    `INSERT INTO whatsapp_sender_auto_reconciliations
        (reservation_id,sender_id,provider_receipt_fingerprint,method,pricing_billable)
      VALUES($1::uuid,$2,$3,$4,$5)
      ON CONFLICT(reservation_id) DO NOTHING RETURNING reservation_id`,
    [reservationId,senderId,
      verified.find(r=>r.pricing_type===evidence.pricing_type && r.pricing_billable===evidence.pricing_billable).fingerprint,
      paid ? (operatorServiceCharge ? 'signed_meta_operator_authorized_service_charge'
        : 'signed_meta_staff_authorized_charge') :
        evidence.pricing_type==='free_customer_service' ?
          'signed_meta_nonbillable_customer_service' : 'signed_meta_nonbillable_free_entry',
      paid]
  );
  if (audit.rowCount !== 1) throw new Error("Early receipt reconciliation already exists");
  const attempt = await client.query(
    "UPDATE whatsapp_sender_billing_attempts SET state='reconciled',updated_at=NOW() WHERE reservation_id=$1::uuid AND sender_id=$2 AND contact_id=$3 AND state='awaiting_pricing'",
    [reservationId,senderId,contactId]
  );
  const gate = await client.query(
    `UPDATE whatsapp_sender_billing_gates SET state='idle',reservation_id=NULL,
       contact_id=NULL,message_id=NULL,wamid=NULL,updated_at=NOW()
       WHERE reservation_id=$1::uuid AND sender_id=$2 AND owner_contact_id=$3 AND state='awaiting_pricing'`,
    [reservationId,senderId,contactId]
  );
  if (attempt.rowCount!==1 || gate.rowCount!==1) {
    throw new Error("Early receipt auto-settlement lost reservation ownership");
  }
  return {matched:verified.length,autoReconciled:true,held:false};
}

module.exports = {applyStagedSecondaryReceipts};
