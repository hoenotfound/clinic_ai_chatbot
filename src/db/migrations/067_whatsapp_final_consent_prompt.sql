-- Optional consent request after the last ordinary follow-up.
-- One row per conversation anchor makes requests idempotent across workers.
CREATE TABLE IF NOT EXISTS whatsapp_consent_prompts (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  anchor_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK (status IN ('claimed','deferred','accepted','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
  retry_after TIMESTAMPTZ,
  response_message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  decision TEXT CHECK (decision IN ('accepted','declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_consent_prompts_contact
  ON whatsapp_consent_prompts(contact_id,created_at DESC);
