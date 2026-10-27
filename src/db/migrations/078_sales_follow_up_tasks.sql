-- Manual personal-WhatsApp follow-up is separate from the bot's follow-up sequence.
-- No historical lead is automatically marked as contacted or booked.
CREATE TABLE sales_follow_up_tasks (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('contacted','later','booked','not_interested','unable')),
  last_inbound_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'later' AND due_at IS NOT NULL)
    OR (status <> 'later' AND (status <> 'booked' OR due_at IS NOT NULL)))
);
CREATE INDEX idx_sales_follow_up_due ON sales_follow_up_tasks(due_at)
  WHERE status = 'later';

CREATE TABLE sales_follow_up_events (
  id BIGSERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('contacted','later','booked','not_interested','unable')),
  inbound_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sales_follow_up_events_lead ON sales_follow_up_events(lead_id, created_at DESC);
