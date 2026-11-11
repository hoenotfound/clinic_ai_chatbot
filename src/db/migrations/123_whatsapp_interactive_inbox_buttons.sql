-- Show the exact native WhatsApp recovery buttons in the staff Inbox.
-- Metadata is written in the same transaction as the outbound assistant row.
-- The column stores button titles/IDs only, never an ad inference or consent.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_interactive JSONB;

COMMENT ON COLUMN messages.whatsapp_interactive IS
  'Read-only staff Inbox snapshot of outgoing WhatsApp interactive buttons.';

-- Existing accepted recovery menus (including the 2026-11-11 first live
-- 131060 case) predate metadata persistence. Reconstruct ONLY the approved
-- fixed menu when the accepted Meta receipt and secondary sender agree.
-- No customer messages, marketing permissions, or old status are changed.
UPDATE messages AS m
SET whatsapp_interactive = jsonb_build_object(
  'type', 'button',
  'buttons', jsonb_build_array(
    jsonb_build_object('id', 'neutro_131060_pelvic', 'title', '骨盆调理'),
    jsonb_build_object('id', 'neutro_131060_3d', 'title', '3D 小颜术'),
    jsonb_build_object('id', 'neutro_131060_9d', 'title', '9D 逆龄抗衰')
  )
)
FROM contacts AS c
JOIN whatsapp_sender_accounts AS sa
  ON sa.id = c.whatsapp_sender_id
JOIN outbound_message_evidence AS receipt
  ON receipt.contact_id = c.id
WHERE m.contact_id = c.id
  AND sa.sender_key = 'neutro_secondary'
  AND m.id = receipt.message_id
  AND receipt.channel = 'whatsapp'
  AND receipt.origin = 'system_fallback'
  AND receipt.accepted IS TRUE
  AND receipt.provider_message_id = m.whatsapp_message_id
  AND m.role = 'assistant'
  AND m.delivery_status IN ('sent', 'delivered', 'read')
  AND m.whatsapp_interactive IS NULL
  AND m.content LIKE 'Hi～欢迎来到 Neutro Sense 😊%'
  AND m.content LIKE '%可以点下面的选项，其他护理（例如脉冲波）也可以直接告诉我们～';
