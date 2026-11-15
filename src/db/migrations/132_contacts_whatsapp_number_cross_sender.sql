-- Index for sender-safe historical cross-number recipient lookups.
-- The eligibility queries search for a normalized WhatsApp number across
-- earlier contacts, sometimes with a NULL sender. Existing indexes start
-- with whatsapp_sender_id or apply only to a NULL sender, forcing repeated
-- full contacts scans when the first sender is not known.
--
-- This index only accelerates the existing predicate. It never expands
-- consent, changes AI/staff ownership, authorizes marketing, or affects
-- outbound billing/reservation checks.
--
-- Production size at benchmark: about 8,312 contacts; staging index 352 kB.
-- The standard migration runner applies this in a transaction at startup.
CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_number_cross_sender
 ON contacts (whatsapp_number, id)
 INCLUDE (whatsapp_sender_id)
 WHERE channel = 'whatsapp';
