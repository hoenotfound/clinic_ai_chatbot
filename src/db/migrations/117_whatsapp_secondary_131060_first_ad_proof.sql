-- A durable, minimal proof of the exceptional Meta 131060 -> first CTWA ad pair.
-- Ordinary completed inbound_processing_jobs are pruned after 24h. Eligibility,
-- fixed first replies and result-media authorization must not depend on them.
-- No raw customer text, media, or webhook payload is retained here.
CREATE TABLE IF NOT EXISTS whatsapp_secondary_131060_first_ads (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE CASCADE,
  unavailable_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  first_ad_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  meta_ad_id TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (unavailable_message_id <> first_ad_message_id),
  CHECK (LENGTH(BTRIM(meta_ad_id)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_secondary_131060_first_ad_sender
  ON whatsapp_secondary_131060_first_ads(sender_id,first_ad_message_id);

-- Backfill ONLY the independently audited 131060 attribution repairs already
-- completed before this schema existed. A stored audit is trusted evidence only
-- after verifying both messages, the same bound sender, matching Meta ad,
-- original first-contact ordering, and the 2-minute limit. No generic
-- 'message unavailable' text is ever used as the source of proof.
WITH audited AS (
  SELECT l.contact_id,
         COALESCE(a.metadata->>'original_message_id',
                  a.metadata->>'unavailableOriginalMessageId') AS initial_id,
         COALESCE(a.metadata->>'verified_ad_message_id',
                  a.metadata->>'verifiedInboundMessageId') AS ad_message_id,
         COALESCE(a.metadata->>'ad_id',a.metadata->>'metaAdId') AS ad_id
  FROM lead_activities a
  JOIN leads l ON l.id=a.lead_id
  JOIN lead_attributions la ON la.lead_id=l.id AND la.source='meta_ads'
  WHERE a.activity_type='attribution' AND a.actor='Automation'
    AND (a.metadata->>'reason'='verified_first_readable_ad'
         OR a.description='Meta 131060 unavailable entry: recovered verified first readable ad.')
    AND COALESCE(a.metadata->>'original_message_id',
                 a.metadata->>'unavailableOriginalMessageId') ~ '^[0-9]{1,9}$'
    AND COALESCE(a.metadata->>'verified_ad_message_id',
                 a.metadata->>'verifiedInboundMessageId') ~ '^[0-9]{1,9}$'
    AND NULLIF(BTRIM(COALESCE(a.metadata->>'ad_id',a.metadata->>'metaAdId','')),'') IS NOT NULL
    AND la.first_message_id=CASE WHEN COALESCE(a.metadata->>'verified_ad_message_id',
       a.metadata->>'verifiedInboundMessageId') ~ '^[0-9]{1,9}$'
       THEN COALESCE(a.metadata->>'verified_ad_message_id',
                     a.metadata->>'verifiedInboundMessageId')::integer END
    AND la.meta_ad_id=COALESCE(a.metadata->>'ad_id',a.metadata->>'metaAdId')
)
INSERT INTO whatsapp_secondary_131060_first_ads
 (contact_id,sender_id,unavailable_message_id,first_ad_message_id,meta_ad_id)
SELECT DISTINCT ON (a.contact_id)
 a.contact_id, sa.id, initial.id, ads_first.id, a.ad_id
FROM audited a
JOIN messages initial ON initial.id=a.initial_id::integer
  AND initial.contact_id=a.contact_id AND initial.role='user'
  AND initial.whatsapp_message_id IS NOT NULL
JOIN messages ads_first ON ads_first.id=a.ad_message_id::integer
  AND ads_first.contact_id=a.contact_id AND ads_first.role='user'
  AND ads_first.whatsapp_message_id IS NOT NULL
JOIN contacts c ON c.id=a.contact_id AND c.channel='whatsapp'
JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
  AND sa.sender_key='neutro_secondary' AND sa.state='active'
JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
  AND sc.contact_id=c.id AND sc.customer_wa_id=c.whatsapp_number
  AND sc.state='bound'
JOIN whatsapp_sender_message_context initial_ctx
  ON initial_ctx.message_id=initial.id AND initial_ctx.conversation_id=sc.id
JOIN whatsapp_sender_message_context ad_ctx
  ON ad_ctx.message_id=ads_first.id AND ad_ctx.conversation_id=sc.id
JOIN whatsapp_free_entry_referrals ref ON ref.origin_message_id=ads_first.id
  AND ref.contact_id=c.id AND ref.source_type='ad' AND ref.meta_ad_id=a.ad_id
WHERE initial.source_created_at IS NOT NULL AND ads_first.source_created_at IS NOT NULL
  AND (initial.created_at,initial.id)<(ads_first.created_at,ads_first.id)
  AND ads_first.created_at<=initial.created_at+INTERVAL '2 minutes'
  AND ads_first.source_created_at>=initial.source_created_at
  AND ads_first.source_created_at<=initial.source_created_at+INTERVAL '2 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM messages other_prior
    WHERE other_prior.contact_id=c.id
      AND (other_prior.created_at,other_prior.id)<(ads_first.created_at,ads_first.id)
      AND other_prior.id<>initial.id
  )
ORDER BY a.contact_id,ads_first.id
ON CONFLICT DO NOTHING;
