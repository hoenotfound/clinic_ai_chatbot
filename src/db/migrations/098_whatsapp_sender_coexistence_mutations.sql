-- WhatsApp Business App text edits and revocations are mutations of an
-- existing phone-side staff message, not new customer conversations.
-- Store out-of-order mutation events for idempotent, bounded later resolution.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_coexistence_mutations (
 id BIGSERIAL PRIMARY KEY,
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 contact_id INTEGER NOT NULL,
 event_wamid TEXT NOT NULL CHECK(length(event_wamid) BETWEEN 6 AND 480),
 target_wamid TEXT NOT NULL CHECK(length(target_wamid) BETWEEN 6 AND 480),
 action TEXT NOT NULL CHECK(action IN('edit','revoke')),
 replacement_text TEXT CHECK(length(replacement_text) <= 4096),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','applied','expired')),
 target_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT whatsapp_sender_coexistence_mutations_contact_fk
   FOREIGN KEY(contact_id,sender_id) REFERENCES contacts(id,whatsapp_sender_id)
   ON DELETE CASCADE,
 CONSTRAINT whatsapp_sender_coexistence_mutations_unique
   UNIQUE(sender_id,event_wamid)
);
CREATE INDEX IF NOT EXISTS idx_sender_coexistence_mutations_pending
  ON whatsapp_sender_coexistence_mutations(sender_id,created_at)
  WHERE status='pending';
COMMENT ON TABLE whatsapp_sender_coexistence_mutations IS
 'Durable and sender-qualified Business App edit/revoke mutations. Never create fake assistant replies or trigger AI and never target a different business sender.';
