-- Staff can explicitly dismiss delivery-related attention without rewriting
-- immutable Meta/provider delivery evidence. A historical failed attachment
-- must not poison future customer turns after the staff dismissal.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS delivery_attention_dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN contacts.delivery_attention_dismissed_at IS
  'Last explicit Inbox attention dismissal; failed sends older than this remain in the delivery audit but do not automatically reopen dismissed attention.';
