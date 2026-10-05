-- Make the lead scoring pointer safe for future message cleanup.
--
-- Migration 036 removes legacy fake WhatsApp reaction messages. A historical
-- lead may still point last_temperature_scored_message_id at one of those rows.
-- The runner contains a compatibility repair before 036 because 036 is already
-- immutable for databases that successfully applied it. This migration makes
-- the foreign key itself safe going forward.

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_last_temperature_scored_message_id_fkey;

ALTER TABLE leads
  ADD CONSTRAINT leads_last_temperature_scored_message_id_fkey
  FOREIGN KEY (last_temperature_scored_message_id)
  REFERENCES messages(id)
  ON DELETE SET NULL;
