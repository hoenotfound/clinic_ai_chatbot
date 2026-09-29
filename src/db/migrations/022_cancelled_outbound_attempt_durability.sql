-- Preserve durable outbound-attempt fencing when a guarded automated send
-- is cancelled before the provider call. The unsent assistant row may be
-- removed, but the attempt itself must survive so restart recovery knows that
-- this inbound job already reached the outbound boundary.

ALTER TABLE inbound_outbound_attempts
  DROP CONSTRAINT IF EXISTS inbound_outbound_attempts_assistant_message_id_fkey;

ALTER TABLE inbound_outbound_attempts
  ALTER COLUMN assistant_message_id DROP NOT NULL;

ALTER TABLE inbound_outbound_attempts
  ADD CONSTRAINT inbound_outbound_attempts_assistant_message_id_fkey
  FOREIGN KEY (assistant_message_id)
  REFERENCES messages(id)
  ON DELETE SET NULL;
