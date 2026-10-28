-- Audited and opt-in WhatsApp Business App coexistence history import.
-- Imported messages remain a passive timeline, NEVER inbound AI triggers,
-- billing windows or automatic follow-up anchors.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_coexistence_sync_events (
  fingerprint TEXT PRIMARY KEY CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  event_field TEXT NOT NULL CHECK(event_field IN('history','smb_app_state_sync')),
  outcome TEXT NOT NULL CHECK(outcome IN('imported','declined','empty')),
  threads_count INTEGER NOT NULL DEFAULT 0,
  messages_count INTEGER NOT NULL DEFAULT 0,
  contacts_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS whatsapp_sender_coexistence_history_messages (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  source_wamid_hash TEXT NOT NULL CHECK(source_wamid_hash ~ '^[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coex_history_sender_wamid
 ON whatsapp_sender_coexistence_history_messages(sender_id,source_wamid_hash);
COMMENT ON TABLE whatsapp_sender_coexistence_history_messages IS
 'Passive business-app history only. EXCLUDE from service-window, AI and automated-follow-up eligibility. Never turn backfill into fresh inbound consent.';
