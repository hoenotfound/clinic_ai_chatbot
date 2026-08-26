-- Patients who've messaged the clinic on WhatsApp.
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  whatsapp_number TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── AI ↔ Human takeover state ──
-- 'ai'    = the bot auto-replies to inbound messages (default).
-- 'human' = a staff member has taken over; the bot stays silent and only
--           staff (via the portal) send replies, until someone hits
--           "Return to AI".
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'human'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS takeover_by TEXT;               -- username of staff who took over, null if mode='ai'
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS takeover_at TIMESTAMPTZ;        -- when the current takeover started

-- True whenever this conversation needs a human's eyes: the AI explicitly
-- handed off, a keyword safety-net matched, or a patient messaged while a
-- staff member already owns the conversation. Cleared when staff takes
-- over / sends a reply / explicitly dismisses it.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS needs_attention BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS attention_reason TEXT;          -- short human-readable reason, shown as a tooltip in the portal

CREATE INDEX IF NOT EXISTS idx_contacts_needs_attention ON contacts(needs_attention) WHERE needs_attention = true;

-- Every inbound (patient) and outbound (assistant) message, so the portal
-- can show full chat history and the AI can still read context.
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  whatsapp_message_id TEXT UNIQUE, -- null for outbound messages we send ourselves
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who actually wrote an outbound ('assistant') message: null means the AI
-- generated it, a username means a staff member sent it manually from the
-- Inbox. Always null for inbound ('user') messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_username TEXT;

-- Image messages (currently just the promo graphic sent on a patient's
-- first message) — media_url is the hosted image link; content holds the
-- caption (may be empty). Null media_url means a plain text message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;

-- Photos and voice notes a *patient* sends us — unlike media_url above (a
-- public link we control, used for outbound images we send), inbound
-- WhatsApp media only gives us a short-lived download URL, so we persist
-- the actual bytes here instead. For a photo this lets the AI look at it in
-- later turns, not just the turn it arrived on (see conversationStore.js,
-- which decides which is which from media_mime_type); for a voice note it's
-- purely so staff can play the original recording in the Inbox (the AI
-- already has the transcript in `content`, so audio bytes are never
-- re-sent to it — see transcriptionService.js).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_base64 TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

-- Clinic configuration editable from the portal's Settings page — clinic
-- name/branches/hours/services/FAQs, plus the AI's tone/playbook/SOP/
-- guardrails text. A single row (id = 1, enforced below) holding the whole
-- config as one JSONB blob, since it's always read and written as one unit
-- (see config/clinicConfig.js and db/configRepo.js) — no per-field columns
-- needed. Seeded from config/clinicConfig.default.js the first time the app
-- starts against a fresh database.
CREATE TABLE IF NOT EXISTS clinic_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clinic_config_single_row CHECK (id = 1)
);

-- Staff who can log into the management portal. All staff currently have
-- identical access — no roles column yet, but adding one later is a small
-- migration, not a redesign.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Placeholder tables for future phases (Pipeline / Contacts CRM fields) ──
-- Not used by any code yet. Created now so the schema is stable and the
-- portal's "Pipeline" tab has something real to attach to when it's built,
-- rather than requiring a migration + data backfill later.

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,          -- e.g. "New Lead", "Contacted", "Booked", "Converted"
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  stage_id INTEGER REFERENCES pipeline_stages(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
