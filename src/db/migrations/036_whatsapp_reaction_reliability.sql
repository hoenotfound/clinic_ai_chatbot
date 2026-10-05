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


-- Remove the fake customer turns created by the pre-035 parser. These rows were
-- never real customer messages, so leaving them behind can keep needs_attention
-- set and can move the follow-up engine's "latest inbound" boundary.
--
-- Keep the cleanup narrowly scoped to WhatsApp contacts and the exact generated
-- placeholder shape. Preserve lead journey boundaries before deleting the rows.
CREATE TEMP TABLE legacy_whatsapp_reaction_messages ON COMMIT DROP AS
SELECT m.id, m.contact_id, m.created_at
FROM messages m
JOIN contacts c ON c.id = m.contact_id
WHERE c.channel = 'whatsapp'
  AND m.role = 'user'
  AND m.content ~ '^📎 \[[^]]+ sent an unsupported reaction message\]$';

-- The self-referencing follow-up anchor does not have ON DELETE behavior in the
-- baseline schema. It should never point at a customer reaction placeholder,
-- but clear it defensively so the cleanup cannot block deployment.
UPDATE messages m
SET automated_follow_up_for_message_id = NULL
WHERE m.automated_follow_up_for_message_id IN (
  SELECT id FROM legacy_whatsapp_reaction_messages
);

-- If an erroneous reaction happened to become a journey boundary, move that
-- boundary to the nearest real message instead of leaving analytics/scoring
-- with a dangling/null start solely because of this cleanup.
UPDATE leads l
SET started_message_id = COALESCE(
  (
    SELECT MIN(candidate.id)
    FROM messages candidate
    WHERE candidate.contact_id = l.contact_id
      AND candidate.id > legacy.id
      AND NOT EXISTS (
        SELECT 1
        FROM legacy_whatsapp_reaction_messages excluded
        WHERE excluded.id = candidate.id
      )
  ),
  (
    SELECT MAX(candidate.id)
    FROM messages candidate
    WHERE candidate.contact_id = l.contact_id
      AND candidate.id < legacy.id
      AND NOT EXISTS (
        SELECT 1
        FROM legacy_whatsapp_reaction_messages excluded
        WHERE excluded.id = candidate.id
      )
  )
)
FROM legacy_whatsapp_reaction_messages legacy
WHERE l.started_message_id = legacy.id;

-- Clear only the exact attention state produced by the old unsupported-reaction
-- path. Never erase a newer or unrelated handoff/attention reason.
UPDATE contacts c
SET needs_attention = false,
    attention_reason = NULL,
    updated_at = NOW()
WHERE c.id IN (
  SELECT DISTINCT contact_id
  FROM legacy_whatsapp_reaction_messages
)
  AND c.needs_attention = true
  AND c.attention_reason = 'Unsupported WhatsApp message (reaction) needs staff review.';

DELETE FROM messages m
WHERE m.id IN (
  SELECT id FROM legacy_whatsapp_reaction_messages
);
