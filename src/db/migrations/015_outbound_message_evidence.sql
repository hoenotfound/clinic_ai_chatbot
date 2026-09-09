CREATE TABLE IF NOT EXISTS outbound_message_evidence (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram')),
  origin TEXT NOT NULL CHECK (origin IN ('ai_reply', 'system_fallback')),
  accepted BOOLEAN NOT NULL,
  provider_message_id TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (accepted = true AND provider_message_id IS NOT NULL AND accepted_at IS NOT NULL)
    OR (accepted = false AND accepted_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS outbound_message_evidence_readiness_idx
  ON outbound_message_evidence (channel, contact_id, origin, attempted_at DESC);

COMMENT ON TABLE outbound_message_evidence IS
  'Per-message provider acceptance evidence for post-provision readiness. Telemetry only; never drives customer delivery.';
