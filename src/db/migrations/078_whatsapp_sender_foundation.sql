-- Multi-number WhatsApp foundation (additive only).
-- Do not activate another sender when this migration lands. Routing, outbound
-- credentials, retries, follow-ups and billing must be sender-scoped first.
-- Never store WhatsApp tokens or other credentials in this table.
CREATE TABLE IF NOT EXISTS whatsapp_sender_accounts (
  id BIGSERIAL PRIMARY KEY,
  sender_key TEXT NOT NULL UNIQUE
    CHECK (sender_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  meta_phone_number_id TEXT NOT NULL UNIQUE
    CHECK (meta_phone_number_id ~ '^[0-9]+$'),
  meta_account_id TEXT NOT NULL
    CHECK (meta_account_id ~ '^[0-9]+$'),
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'disabled'
    CHECK (state IN ('disabled', 'testing', 'active')),
  coexistence_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No ALTER TABLE on legacy contacts/messages at this stage. These tables
-- remain fully unchanged until the two-number contact and outbound routing
-- implementation is ready for an independently staged migration.
-- Existing unique constraints and indexes are also kept intact.

-- Record unexpected Meta callbacks without storing their raw customer content.
-- The only key is a SHA-256 hash of the event, so Meta retries are idempotent.
CREATE TABLE IF NOT EXISTS whatsapp_sender_quarantined_events (
  fingerprint TEXT PRIMARY KEY
    CHECK (fingerprint ~ '^[a-f0-9]{64}
),
  reason TEXT NOT NULL
    CHECK (reason IN (
      'different_business_phone',
      'invalid_business_phone',
      'missing_business_phone',
      'unsupported_whatsapp_event',
      'invalid_whatsapp_entry',
      'invalid_whatsapp_webhook',
      'malformed_whatsapp_change'
    )),
  event_field TEXT NOT NULL,
  meta_account_id TEXT,
  meta_phone_number_id TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count BIGINT NOT NULL DEFAULT 1
);
-- No backfill, changes to hot customer tables, historical data rewrite,
-- or sender activation in this migration.
