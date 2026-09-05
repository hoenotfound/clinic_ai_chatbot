CREATE TABLE IF NOT EXISTS messaging_runtime_health (
  channel TEXT PRIMARY KEY CHECK (channel IN ('facebook', 'instagram')),
  last_outbound_accepted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE messaging_runtime_health IS
  'Low-volume channel health timestamps only. Stores no message content, customer identifiers, recipients, credentials, or provider message IDs.';
