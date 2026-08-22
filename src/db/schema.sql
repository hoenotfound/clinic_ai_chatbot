-- Patients who've messaged the clinic on WhatsApp.
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  whatsapp_number TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

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
