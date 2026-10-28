-- Save the receiving Meta business identity with durable delivery and pricing evidence.
-- NULL is preserved for historical callbacks without sender metadata.
SET LOCAL lock_timeout = '3s';
ALTER TABLE IF EXISTS whatsapp_delivery_status_jobs
  ADD COLUMN IF NOT EXISTS business_phone_number_id TEXT;
ALTER TABLE IF EXISTS whatsapp_delivery_status_jobs
  ADD COLUMN IF NOT EXISTS business_account_id TEXT;
ALTER TABLE IF EXISTS whatsapp_free_entry_pricing_evidence
  ADD COLUMN IF NOT EXISTS business_phone_number_id TEXT;
ALTER TABLE IF EXISTS whatsapp_free_entry_pricing_evidence
  ADD COLUMN IF NOT EXISTS business_account_id TEXT;
