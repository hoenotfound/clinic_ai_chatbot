/**
 * Meta's free-entry pricing confirms an active window, not a fresh restart
 * for every ad click. Associate overlapping verified replies with the FIRST
 * qualifying epoch, then allow a new epoch only after that one expires.
 * A later unpriced ad click never hides the previous verified epoch.
 */
function sessionLateralSql({ contactAlias = "c", ceilingParam = "$8" } = {}) {
  return `JOIN LATERAL (
    WITH RECURSIVE qualified AS (
      SELECT entry.origin_message_id, entry.ctwa_clid, entry.meta_ad_id,
             entry.treatment_interest AS referral_treatment_interest,
             reply.id AS reply_id, reply.created_at AS reply_at,
             ROW_NUMBER() OVER (
               ORDER BY reply.created_at, reply.id, entry.origin_message_id
             ) AS rn
      FROM whatsapp_free_entry_referrals entry
      JOIN messages ad_message ON ad_message.id=entry.origin_message_id
        AND ad_message.contact_id=${contactAlias}.id AND ad_message.role='user'
      JOIN LATERAL (
        SELECT m.id, m.created_at, m.whatsapp_message_id
        FROM messages m
        WHERE m.contact_id=${contactAlias}.id AND m.role='assistant'
          AND m.whatsapp_message_id IS NOT NULL
          AND m.created_at >= ad_message.created_at
          AND m.created_at < ad_message.created_at + interval '24 hours'
        ORDER BY m.created_at, m.id LIMIT 1
      ) reply ON true
      JOIN whatsapp_free_entry_pricing_evidence priced
        ON priced.wamid=reply.whatsapp_message_id
        AND priced.pricing_type='free_entry_point'
        AND priced.billable=false
        AND priced.delivery_status IN ('sent','delivered','read')
      WHERE entry.contact_id=${contactAlias}.id
    ),
    epochs AS (
      SELECT q.rn, q.reply_at AS epoch_start, q.origin_message_id AS epoch_origin
      FROM qualified q WHERE q.rn=1
      UNION ALL
      SELECT later.rn,
        CASE WHEN later.reply_at >= earlier.epoch_start +
          (${ceilingParam}::integer * interval '1 hour')
          THEN later.reply_at ELSE earlier.epoch_start END,
        CASE WHEN later.reply_at >= earlier.epoch_start +
          (${ceilingParam}::integer * interval '1 hour')
          THEN later.origin_message_id ELSE earlier.epoch_origin END
      FROM epochs earlier JOIN qualified later ON later.rn=earlier.rn+1
    )
    SELECT anchor.origin_message_id, anchor.ctwa_clid, anchor.meta_ad_id,
      anchor.referral_treatment_interest
    FROM epochs latest
    JOIN qualified anchor ON anchor.origin_message_id=latest.epoch_origin
    ORDER BY latest.rn DESC LIMIT 1
  ) referral ON true`;
}
module.exports = { sessionLateralSql };
