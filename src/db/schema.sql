-- Patients who've messaged the clinic on WhatsApp.
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  whatsapp_number TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The display name supplied by WhatsApp in inbound webhook payloads. Keep
-- this separate from `name`, which staff can edit in the portal, so a later
-- WhatsApp profile change never overwrites a clinic's own contact name.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_profile_name TEXT;

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

-- Inbox workflow state. Unread is shared across clinic staff, so opening a
-- conversation marks it read for the team. Follow-up is an explicit staff
-- flag that remains set until somebody clears it.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_unread BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS needs_follow_up BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_contacts_is_unread ON contacts(is_unread) WHERE is_unread = true;
CREATE INDEX IF NOT EXISTS idx_contacts_needs_follow_up ON contacts(needs_follow_up) WHERE needs_follow_up = true;

-- Which inbound channel this contact came from. Everyone today is
-- 'whatsapp' (the only channel this app talks to), but this is here so
-- Instagram/Facebook Messenger contacts can be told apart once those
-- channels are wired up — each gets its own badge icon in the portal.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'instagram', 'facebook'));

-- Public URL of the contact's real profile photo, when the channel's API
-- provides one. WhatsApp's Cloud API does not expose a patient's profile
-- picture at all, so this stays NULL for WhatsApp contacts and the portal
-- falls back to a silhouette. Instagram/Facebook Messenger's APIs do return
-- a profile_pic URL for a user, so this column is ready to be populated
-- once those integrations exist.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Freeform staff notes on a contact — shown on their profile in the
-- Contacts directory (see routes/contacts.js, db/contactNotesRepo.js).
-- Independent of `messages`: these are internal staff notes, never sent to
-- the patient or seen by the AI.
CREATE TABLE IF NOT EXISTS contact_notes (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_notes_contact_id ON contact_notes(contact_id);

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

-- Async delivery outcome for an outbound message, as reported later by
-- Meta's status webhook callback (see server.js POST /webhook, which reads
-- value.statuses). Accepting a send request (HTTP 200 from the /messages
-- call) only means Meta queued it — actual delivery/failure is reported
-- separately and asynchronously. delivery_status is one of
-- 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown' (or null
-- if we never captured a whatsapp_message_id for this row to match a status
-- update against, e.g. messages sent before this column existed). 'pending'
-- means Meta accepted the request but has not reported a delivery status yet.
-- 'unknown' means the app restarted after claiming an automated follow-up but
-- before it could record WhatsApp's response. delivery_error holds Meta's
-- human-readable error or the reason delivery could not be confirmed.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error TEXT;

-- Automated follow-ups are normal outbound messages, but they need two
-- extra pieces of bookkeeping: a marker so an automated follow-up never
-- schedules another follow-up, and the exact outbound message that started
-- its timer. The partial unique index makes the scheduler safe when more
-- than one server instance checks the same conversation at once.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_automated_follow_up BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS automated_follow_up_for_message_id INTEGER REFERENCES messages(id);

CREATE INDEX IF NOT EXISTS idx_messages_contact_id ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_contact_created_at_id ON messages(contact_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_contact_id_desc ON messages(contact_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_one_automated_follow_up_per_trigger
  ON messages(automated_follow_up_for_message_id)
  WHERE automated_follow_up_for_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_unconfirmed_automated_followups
  ON messages(created_at, id)
  WHERE is_automated_follow_up = true
    AND whatsapp_message_id IS NULL
    AND delivery_status IS NULL;

-- Promo graphics uploaded directly from the Settings > Promotions page.
-- Stored as base64 bytes (same pattern as patient-sent photos in messages)
-- and served back out at a public URL (see GET /promo-images/:id in
-- server.js) — WhatsApp's Cloud API needs a real, publicly fetchable URL to
-- send an image message by link, it can't take an upload directly for this
-- flow (contrast with staff Inbox uploads, which go straight to WhatsApp's
-- own media endpoint instead — see services/whatsappService.js uploadMedia()).
CREATE TABLE IF NOT EXISTS promo_images (
  id SERIAL PRIMARY KEY,
  mime_type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ── Lead pipeline ──
-- Pipeline progress is deliberately separate from conversation state. A lead
-- can be Hot, assigned to Puchong, waiting for a reschedule, and still sit in
-- the Appointment Set stage at the same time.

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#2f6f62',
  stage_type TEXT NOT NULL DEFAULT 'open',
  system_key TEXT
);

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#2f6f62';
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS stage_type TEXT NOT NULL DEFAULT 'open';
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS system_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_system_key
  ON pipeline_stages(system_key)
  WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_stages_name_ci
  ON pipeline_stages(lower(name));

-- Seed the clinic-friendly defaults only when the placeholder table is empty.
-- Staff can rename and reorder these workflow stages, and add their own later.
INSERT INTO pipeline_stages (name, sort_order, color, stage_type, system_key)
SELECT seed.name, seed.sort_order, seed.color, seed.stage_type, seed.system_key
FROM (VALUES
  ('New Lead', 10, '#397a6d', 'open', 'new'),
  ('Contacted', 20, '#3b82a0', 'open', 'contacted'),
  ('Appointment Set', 30, '#c58b2a', 'open', 'appointment_set'),
  ('Visited Clinic', 40, '#7c62a3', 'open', 'visited'),
  ('Converted / Won', 50, '#2f7d4e', 'won', 'won'),
  ('Closed / Lost', 60, '#a94b3d', 'lost', 'lost')
) AS seed(name, sort_order, color, stage_type, system_key)
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages);

CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  stage_id INTEGER REFERENCES pipeline_stages(id),
  notes TEXT,
  temperature TEXT NOT NULL DEFAULT 'warm',
  branch_name TEXT,
  owner_username TEXT,
  treatment_interest TEXT,
  estimated_value NUMERIC(12, 2),
  source TEXT,
  campaign_name TEXT,
  appointment_status TEXT NOT NULL DEFAULT 'none',
  appointment_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  lost_reason TEXT,
  marketing_consent TEXT NOT NULL DEFAULT 'unknown',
  is_closed BOOLEAN NOT NULL DEFAULT false,
  closed_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature TEXT NOT NULL DEFAULT 'warm';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS branch_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_username TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS treatment_interest TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS estimated_value NUMERIC(12, 2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS marketing_consent TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature_source TEXT NOT NULL DEFAULT 'system'
  CHECK (temperature_source IN ('system', 'rule', 'ai', 'manual'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature_locked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS started_message_id INTEGER
  REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_temperature_scored_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_temperature_scored_message_id INTEGER REFERENCES messages(id);

-- Hot and Cold values that predate temperature_source/temperature_locked were
-- staff choices. Mark only legacy system rows, so future rule/AI rows remain
-- automatic and this stays safe to run on every startup.
UPDATE leads
SET temperature_source = 'manual', temperature_locked = true
WHERE temperature IN ('hot', 'cold')
  AND temperature_source = 'system'
  AND temperature_locked = false;

-- Give existing journeys a stable transcript boundary. Automated leads start
-- at the inbound message that created them. Initial backfilled journeys cover
-- their existing conversation. Staff-created journeys begin with the first
-- message sent after the lead was created, never the final message from a
-- previously closed journey.
UPDATE leads l
SET started_message_id = CASE
  WHEN l.created_by = 'Migration' THEN (
    SELECT MIN(m.id) FROM messages m WHERE m.contact_id = l.contact_id
  )
  WHEN l.created_by = 'Automation' THEN COALESCE(
    (
      SELECT m.id FROM messages m
      WHERE m.contact_id = l.contact_id AND m.created_at <= l.created_at
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1
    ),
    (SELECT MIN(m.id) FROM messages m WHERE m.contact_id = l.contact_id)
  )
  ELSE (
    SELECT MIN(m.id) FROM messages m
    WHERE m.contact_id = l.contact_id AND m.created_at >= l.created_at
  )
END
WHERE l.started_message_id IS NULL;

-- Correct staff-created rows if an earlier preview of this migration used the
-- last old message as their inclusive boundary. This remains safe on restart:
-- it always resolves to the first message created during that staff-started
-- journey, or NULL while the journey has no messages of its own.
UPDATE leads l
SET started_message_id = (
  SELECT MIN(m.id) FROM messages m
  WHERE m.contact_id = l.contact_id AND m.created_at >= l.created_at
)
WHERE COALESCE(l.created_by, '') NOT IN ('Automation', 'Migration')
  AND l.started_message_id IS DISTINCT FROM (
    SELECT MIN(m.id) FROM messages m
    WHERE m.contact_id = l.contact_id AND m.created_at >= l.created_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_one_open_per_contact
  ON leads(contact_id)
  WHERE is_closed = false;
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_branch ON leads(branch_name) WHERE branch_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_leads_follow_up
  ON leads(next_follow_up_at)
  WHERE is_closed = false AND next_follow_up_at IS NOT NULL;

-- Durable queue and audit history for end-of-conversation AI scoring. The
-- unique lead/message pair is the idempotency key, so webhook retries or two
-- Render instances cannot score the same transcript snapshot twice.
CREATE TABLE IF NOT EXISTS lead_temperature_scores (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  through_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('inactivity', 'time_ceiling', 'message_ceiling')),
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'superseded', 'failed', 'cancelled')),
  temperature TEXT CHECK (temperature IN ('hot', 'warm', 'cold')),
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  reason TEXT,
  evidence_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  applied BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 1,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, through_message_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_temperature_scores_latest
  ON lead_temperature_scores(lead_id, through_message_id DESC);
CREATE INDEX IF NOT EXISTS idx_lead_temperature_scores_recovery
  ON lead_temperature_scores(status, updated_at)
  WHERE status IN ('processing', 'failed');

CREATE TABLE IF NOT EXISTS lead_stage_history (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  to_stage_id INTEGER REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  changed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_stage_history_lead
  ON lead_stage_history(lead_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS lead_activities (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  description TEXT NOT NULL,
  actor TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead
  ON lead_activities(lead_id, created_at DESC, id DESC);
