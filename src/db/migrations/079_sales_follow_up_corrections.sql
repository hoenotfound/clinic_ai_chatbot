-- Separate migration: never edit an already-applied 078 checksum.
ALTER TABLE sales_follow_up_events
  ADD COLUMN previous_state JSONB,
  ADD COLUMN undone_at TIMESTAMPTZ,
  ADD COLUMN undone_by TEXT;
CREATE INDEX idx_sales_follow_up_events_recent
  ON sales_follow_up_events(actor, created_at DESC)
  WHERE undone_at IS NULL;
