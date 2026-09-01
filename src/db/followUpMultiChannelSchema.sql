-- Messenger and Instagram accepted sends do not use WhatsApp WAMIDs. The
-- normal Inbox retry path therefore clears a failed/unknown social message
-- back to a neutral delivery state after Meta accepts it. For automated
-- follow-ups, a neutral state is also the crash-recovery marker, so normalize
-- that specific successful-retry transition to 'sent'. This keeps the generic
-- Inbox retry code unchanged and prevents the follow-up recovery sweep from
-- later misclassifying a successfully retried social message as unconfirmed.
CREATE OR REPLACE FUNCTION normalize_social_automated_follow_up_retry_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_automated_follow_up = true
     AND OLD.delivery_status IN ('failed', 'unknown')
     AND NEW.delivery_status IS NULL
     AND NEW.delivery_error IS NULL
     AND EXISTS (
       SELECT 1
       FROM contacts c
       WHERE c.id = NEW.contact_id
         AND c.channel IN ('facebook', 'instagram')
     )
  THEN
    NEW.delivery_status := 'sent';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_social_automated_follow_up_retry_status ON messages;
CREATE TRIGGER trg_social_automated_follow_up_retry_status
BEFORE UPDATE OF delivery_status, delivery_error ON messages
FOR EACH ROW
EXECUTE FUNCTION normalize_social_automated_follow_up_retry_status();
