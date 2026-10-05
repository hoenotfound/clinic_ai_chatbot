-- Keep WhatsApp reaction events durable even when Meta delivers the reaction
-- before the referenced message WAMID has been attached to our local row.
--
-- provider_timestamp preserves Meta event ordering so a delayed retry cannot
-- overwrite a newer reaction. Empty emoji values are retained as tombstones in
-- message_reactions; portal queries filter them out, while the timestamp remains
-- available to reject stale retries after a reaction was removed.

ALTER TABLE message_reactions
  ADD COLUMN IF NOT EXISTS provider_timestamp BIGINT;

CREATE TABLE IF NOT EXISTS pending_whatsapp_reactions (
  id BIGSERIAL PRIMARY KEY,
  target_whatsapp_message_id TEXT NOT NULL,
  reactor_key TEXT NOT NULL,
  reactor_whatsapp_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  provider_reaction_message_id TEXT,
  provider_timestamp BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_whatsapp_message_id, reactor_key)
);

CREATE INDEX IF NOT EXISTS idx_pending_whatsapp_reactions_target
  ON pending_whatsapp_reactions (target_whatsapp_message_id);

CREATE INDEX IF NOT EXISTS idx_pending_whatsapp_reactions_updated
  ON pending_whatsapp_reactions (updated_at);

-- Reaction target lookup normally hits messages.whatsapp_message_id. These two
-- partial indexes keep the historical/provider-evidence fallbacks cheap.
CREATE INDEX IF NOT EXISTS idx_outbound_message_evidence_whatsapp_provider
  ON outbound_message_evidence (provider_message_id)
  WHERE channel = 'whatsapp'
    AND accepted = true
    AND provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_outbound_attempts_accepted_provider
  ON inbound_outbound_attempts (provider_message_id)
  WHERE outcome = 'accepted'
    AND provider_message_id IS NOT NULL;
