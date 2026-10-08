-- Diagnostic-only skip reasons; these do not authorize a future send.
CREATE TABLE IF NOT EXISTS whatsapp_free_entry_followup_skips (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  first_reply_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  slot_hours INTEGER NOT NULL,
  reason TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(first_reply_message_id,slot_hours,reason)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_fep_skips_contact
 ON whatsapp_free_entry_followup_skips(contact_id,observed_at DESC);