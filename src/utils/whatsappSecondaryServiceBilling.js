"use strict";

// Default to strict mode unless the operator explicitly enables record-only
// service billing. This does not disable the transport, receipts or alarms.
function serviceBillingRecordOnlyEnabled(env=process.env){
 return env.WHATSAPP_SECONDARY_SENDER_KEY==="neutro_secondary" &&
   env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED==="true" &&
   env.WHATSAPP_SECONDARY_SERVICE_BILLING_RECORD_ONLY==="true";
}
function authorizedServiceAttemptSql(alias){
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error("Invalid service attempt alias");
 return `(${alias}.billable_authorized=TRUE AND
   ${alias}.billing_authorization_source='operator_acknowledged_service')`;
}
// Only a delivery warning backed by an authorized service attempt (or a
// provably unsent draft blocked by that attempt) is informational. Do not
// suppress clinical, takeover, booking, opt-out, or sender alarm checks.
function independentServiceDeliveryAttentionSql(alias="c",env=process.env){
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error("Invalid contact alias");
 if(!serviceBillingRecordOnlyEnabled(env))return "FALSE";
 return `(
   ${alias}.mode='ai' AND ${alias}.needs_attention=TRUE
   AND ${alias}.takeover_by IS NULL AND ${alias}.whatsapp_opt_out_at IS NULL
   AND EXISTS(SELECT 1 FROM whatsapp_sender_accounts sa
     WHERE sa.id=${alias}.whatsapp_sender_id AND sa.sender_key='neutro_secondary' AND sa.state='active')
   AND (${alias}.attention_reason LIKE 'Delivery failed:%'
        OR ${alias}.attention_reason LIKE 'Delivery unconfirmed:%')
   AND NOT EXISTS(SELECT 1 FROM ai_review_items pending
     WHERE pending.contact_id=${alias}.id AND pending.status='pending')
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_alarms alarm
     WHERE alarm.sender_id=${alias}.whatsapp_sender_id)
   AND EXISTS(
     SELECT 1 FROM messages warning
     JOIN whatsapp_sender_billing_attempts a ON a.contact_id=warning.contact_id
       AND a.sender_id=${alias}.whatsapp_sender_id
     JOIN messages original ON original.id=a.message_id AND original.contact_id=a.contact_id
       AND original.role='assistant'
     WHERE warning.id=${alias}.delivery_attention_message_id
       AND warning.contact_id=${alias}.id AND warning.role='assistant'
       AND ${authorizedServiceAttemptSql("a")}
       AND (a.state IN ('unknown','awaiting_pricing','reconciled','rejected') OR
         (a.state='reserved' AND a.updated_at<=NOW()-INTERVAL '30 minutes'))
       AND (original.id=warning.id OR (
         original.created_at<warning.created_at AND warning.delivery_status='failed'
         AND warning.whatsapp_message_id IS NULL AND warning.whatsapp_accepted_at IS NULL
         AND warning.delivery_error IN (
           'The previous WhatsApp message is still being confirmed. Check its delivery before another send.',
           'An earlier WhatsApp send is unconfirmed. Ask an administrator to review non-delivery and billing before composing a new message.')
         AND ${alias}.attention_reason='Delivery failed: ' || warning.delivery_error
         AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts b WHERE b.message_id=warning.id)
         AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e WHERE e.message_id=warning.id)
         AND (a.service_receipt_independent=TRUE OR EXISTS(
           SELECT 1 FROM whatsapp_sender_billing_gates blocker
           WHERE blocker.reservation_id=a.reservation_id AND blocker.sender_id=a.sender_id
             AND blocker.owner_contact_id=a.contact_id AND blocker.state IN ('unknown','awaiting_pricing','reserved')
         ))
       ))
   )
 )`;
}
// Discovery of later, distinct jobs may ignore a finished service billing
// hold. Actual reservations still verify exact sender, contact and charge approval.
function detachableServiceGateSql(gateAlias,env=process.env){
 if(!/^[a-z][a-z0-9_]*$/i.test(gateAlias))throw Error("Invalid gate alias");
 if(!serviceBillingRecordOnlyEnabled(env))return "FALSE";
 return `EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts independent
   WHERE independent.reservation_id=${gateAlias}.reservation_id
     AND independent.sender_id=${gateAlias}.sender_id
     AND independent.contact_id=${gateAlias}.owner_contact_id
     AND independent.message_id=${gateAlias}.message_id
     AND independent.state=${gateAlias}.state
     AND (independent.state IN ('unknown','awaiting_pricing') OR (
       independent.state='reserved' AND independent.updated_at<=NOW()-INTERVAL '30 minutes'
       AND ${gateAlias}.updated_at<=NOW()-INTERVAL '30 minutes'))
     AND ${authorizedServiceAttemptSql("independent")})`;
}
// Distinct scheduled stages may proceed after an uncertain authorized
// service attempt, but the original one-shot slot remains consumed.
function independentUnknownFollowupSql(alias,env=process.env){
 if(!/^[a-z][a-z0-9_]*$/i.test(alias))throw Error("Invalid follow-up attempt alias");
 if(!serviceBillingRecordOnlyEnabled(env))return "FALSE";
 return `(${alias}.status='unknown' AND ${alias}.completed_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts a
     WHERE a.message_id=${alias}.message_id AND a.sender_id=${alias}.sender_id
       AND a.contact_id=${alias}.contact_id AND a.state IN ('unknown','awaiting_pricing','reconciled')
       AND ${authorizedServiceAttemptSql("a")}))`;
}
module.exports={serviceBillingRecordOnlyEnabled,authorizedServiceAttemptSql,independentUnknownFollowupSql,
 independentServiceDeliveryAttentionSql,detachableServiceGateSql};
