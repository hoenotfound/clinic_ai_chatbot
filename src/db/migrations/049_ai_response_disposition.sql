-- Differentiate provider-level completion from a response actually accepted
-- by the chatbot's structured-output validator.
-- Existing usage history is intentionally preserved with NULL disposition.
-- Timeout abort is client-side; it does not guarantee provider-side billing stops.
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS response_disposition VARCHAR(32);

ALTER TABLE ai_usage_events
  ADD CONSTRAINT ai_usage_events_response_disposition_check
  CHECK (
    response_disposition IS NULL
    OR response_disposition IN (
      'accepted', 'provider_completed', 'rejected_invalid_output',
      'discarded_timeout', 'aborted_without_usage', 'provider_error'
    )
  );
