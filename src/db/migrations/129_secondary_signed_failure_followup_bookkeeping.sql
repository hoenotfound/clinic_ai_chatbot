-- Reconcile *scheduler bookkeeping only* for old, verified secondary Meta
-- failures (including Peggy's November 13 video). The exact original message
-- and its signed failure receipt must match a secondary billing reservation.
-- Never release a billing gate, change the historical billing attempt,
-- authorize a new send, or retry the original message.

UPDATE whatsapp_sender_followup_attempts followup
SET status='unknown',
    error_code='secondary_signed_meta_delivery_failed_backfill'
FROM whatsapp_sender_billing_attempts billing
JOIN whatsapp_sender_accounts sender
  ON sender.id=billing.sender_id AND sender.sender_key='neutro_secondary'
JOIN messages outbound
  ON outbound.id=billing.message_id AND outbound.contact_id=billing.contact_id
WHERE followup.sender_id=billing.sender_id
  AND followup.contact_id=billing.contact_id
  AND followup.message_id=billing.message_id
  AND followup.status='accepted'
  AND billing.state='unknown'
  AND outbound.role='assistant' AND outbound.delivery_status='failed'
  AND EXISTS (
    SELECT 1 FROM whatsapp_sender_status_receipts receipt
    WHERE receipt.sender_id=billing.sender_id
      AND receipt.reservation_id=billing.reservation_id
      AND receipt.matched=TRUE
      AND receipt.wamid=billing.wamid
      AND receipt.delivery_status='failed'
  );

UPDATE whatsapp_sender_marketing_followup_attempts followup
SET status='unknown',
    error_code='secondary_signed_meta_delivery_failed_backfill'
FROM whatsapp_sender_billing_attempts billing
JOIN whatsapp_sender_accounts sender
  ON sender.id=billing.sender_id AND sender.sender_key='neutro_secondary'
JOIN messages outbound
  ON outbound.id=billing.message_id AND outbound.contact_id=billing.contact_id
WHERE followup.sender_id=billing.sender_id
  AND followup.contact_id=billing.contact_id
  AND followup.message_id=billing.message_id
  AND followup.status='accepted'
  AND billing.state='unknown'
  AND outbound.role='assistant' AND outbound.delivery_status='failed'
  AND EXISTS (
    SELECT 1 FROM whatsapp_sender_status_receipts receipt
    WHERE receipt.sender_id=billing.sender_id
      AND receipt.reservation_id=billing.reservation_id
      AND receipt.matched=TRUE
      AND receipt.wamid=billing.wamid
      AND receipt.delivery_status='failed'
  );
