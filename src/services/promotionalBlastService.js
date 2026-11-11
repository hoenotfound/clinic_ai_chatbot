"use strict";

// Small, opt-in blast campaign: never sends from a query/claim.
// The final message always goes through the existing sender-specific Inbox
// template route (Meta approval, opt-in, media and billing-review checks).
const { pool } = require("../db/db");

const CAMPAIGN_KEY = "ns_3d_1111_rm388_2026";
const CAMPAIGN_LABEL = "11.11 3D 小颜术 · RM388";
const LANGUAGES = new Set(["zh_CN", "en_US", "ms"]);
const CANDIDATE_SQL = "\nWITH active_leads AS (\n  SELECT DISTINCT ON (l.contact_id)\n    l.contact_id, l.treatment_interest, l.marketing_consent,\n    l.is_closed, l.appointment_status, l.stage_id\n  FROM leads l\n  JOIN contacts c ON c.id=l.contact_id\n  WHERE c.channel='whatsapp' AND c.whatsapp_sender_id IN (1,2)\n    AND l.treatment_interest IN ('3D 小颜术','9D 逆龄抗衰','3D + 9D 组合')\n    AND EXISTS (\n      SELECT 1 FROM whatsapp_free_entry_referrals r\n      JOIN messages origin ON origin.id=r.origin_message_id\n      WHERE r.contact_id=c.id AND r.source_type='ad'\n        AND origin.created_at>now()-interval '7 days'\n    )\n  ORDER BY l.contact_id,l.is_closed ASC,l.created_at DESC,l.id DESC\n),\ncandidates AS (\n  SELECT c.id AS contact_id, c.whatsapp_sender_id AS sender_id,\n    CASE WHEN c.whatsapp_number ~ '^\\+?[0-9]{8,15}

async function candidates(database = pool) {
  const result = await database.query(
    `SELECT qualified.*,
      EXISTS (
        SELECT 1 FROM whatsapp_promotional_blast_claims claim
        WHERE claim.campaign_key=$1 AND claim.recipient_key=qualified.recipient_key
      ) AS already_claimed
    FROM (${CANDIDATE_SQL}) qualified
    ORDER BY qualified.safe_expires_at ASC, qualified.contact_id ASC LIMIT 100`,
    [CAMPAIGN_KEY]
  );
  return result.rows || [];
}

async function claimRecipient(contactId, languageCode, staffUsername, database = pool) {
  if (!Number.isSafeInteger(contactId) || contactId <= 0 ||
      !LANGUAGES.has(languageCode) || !staffUsername) return null;
  const result = await database.query(
    `INSERT INTO whatsapp_promotional_blast_claims
      (campaign_key,contact_id,recipient_key,sender_id,language_code,staff_username)
    SELECT $1,qualified.contact_id,qualified.recipient_key,
      qualified.sender_id,$3,$4
    FROM (${CANDIDATE_SQL}) qualified
    WHERE qualified.contact_id=$2 AND qualified.blocked_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_promotional_blast_claims prior
        WHERE prior.campaign_key=$1 AND prior.recipient_key=qualified.recipient_key
      )
    ON CONFLICT DO NOTHING
    RETURNING id,contact_id`,
    [CAMPAIGN_KEY,contactId,languageCode,staffUsername]
  );
  return result.rows?.[0] || null;
}

// Irreversibly consume a claim before the existing template send path.
// This prevents refresh, double-click and ambiguous delivery from causing
// the browser to transmit another campaign message.
async function consumeClaim(contactId, campaignKey, languageCode, staffUsername, database = pool) {
  if (campaignKey !== CAMPAIGN_KEY || !LANGUAGES.has(languageCode) || !staffUsername) return false;
  const result = await database.query(
    `UPDATE whatsapp_promotional_blast_claims claim
    SET state='attempted', attempted_at=now()
    FROM (${CANDIDATE_SQL}) qualified
    WHERE claim.campaign_key=$1 AND claim.contact_id=$2
      AND claim.staff_username=$3 AND claim.language_code=$4
      AND claim.state='reserved'
      AND qualified.contact_id=claim.contact_id
      AND qualified.recipient_key=claim.recipient_key
      AND qualified.blocked_reason IS NULL
    RETURNING claim.id`,
    [CAMPAIGN_KEY,contactId,staffUsername,languageCode]
  );
  return result.rows?.length === 1;
}

module.exports = {
  CAMPAIGN_KEY, CAMPAIGN_LABEL, LANGUAGES,
  CANDIDATE_SQL, candidates, claimRecipient, consumeClaim,
};
\n      THEN regexp_replace(c.whatsapp_number,'[^0-9]','','g')\n      ELSE 'contact:'||c.id::text END AS recipient_key,\n    COALESCE(NULLIF(c.whatsapp_profile_name,''),NULLIF(c.name,''),'Contact '||c.id) AS contact_name,\n    l.treatment_interest, session.first_reply_at,\n    session.first_reply_at+interval '167 hours' AS safe_expires_at,\n    CASE WHEN inbound.content ~ '[一-龥]' THEN 'zh_CN'\n         WHEN lower(coalesce(inbound.content,'')) ~ '(boleh|berapa|rawatan|nak |saya |harga)' THEN 'ms'\n         ELSE 'en_US' END AS suggested_language,\n    CASE WHEN c.whatsapp_sender_id=2 AND EXISTS (\n      SELECT 1 FROM whatsapp_sender_billing_alarms alarm\n      WHERE alarm.sender_id=2\n    ) THEN 'secondary_billing_alarm'\n    WHEN c.whatsapp_sender_id=2 AND EXISTS (\n      SELECT 1 FROM whatsapp_sender_billing_gates gate\n      WHERE gate.sender_id=2 AND gate.state<>'idle'\n    ) THEN 'secondary_billing_unresolved'\n    ELSE NULL END AS blocked_reason\n  FROM active_leads l\n  JOIN contacts c ON c.id=l.contact_id\n  LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id\n  JOIN LATERAL (\n    SELECT entry.origin_message_id, reply.id AS first_reply_id, reply.created_at AS first_reply_at\n    FROM whatsapp_free_entry_referrals entry\n    JOIN messages origin ON origin.id=entry.origin_message_id\n      AND origin.contact_id=c.id AND origin.role='user'\n      AND origin.whatsapp_message_id IS NOT NULL\n    JOIN LATERAL (\n      SELECT m.id,m.created_at,m.whatsapp_message_id\n      FROM messages m\n      WHERE m.contact_id=c.id AND m.role='assistant'\n        AND m.whatsapp_message_id IS NOT NULL\n        AND m.created_at>=origin.created_at\n        AND m.created_at<origin.created_at+interval '24 hours'\n      ORDER BY m.created_at,m.id LIMIT 1\n    ) reply ON true\n    WHERE entry.contact_id=c.id AND entry.source_type='ad'\n      AND (entry.meta_ad_id IS NOT NULL OR entry.ctwa_clid IS NOT NULL)\n      AND origin.created_at>now()-interval '7 days'\n      AND reply.created_at>now()-interval '167 hours'\n      -- An overlapping repeat ad click does not start another free-entry\n      -- period. Only the earliest qualified reply in the rolling 168h window\n      -- can anchor this campaign eligibility.\n      AND NOT EXISTS (\n        SELECT 1\n        FROM whatsapp_free_entry_referrals earlier_entry\n        JOIN messages earlier_origin ON earlier_origin.id=earlier_entry.origin_message_id\n          AND earlier_origin.contact_id=c.id AND earlier_origin.role='user'\n          AND earlier_origin.whatsapp_message_id IS NOT NULL\n        JOIN LATERAL (\n          SELECT r.id,r.created_at,r.whatsapp_message_id\n          FROM messages r\n          WHERE r.contact_id=c.id AND r.role='assistant'\n            AND r.whatsapp_message_id IS NOT NULL\n            AND r.created_at>=earlier_origin.created_at\n            AND r.created_at<earlier_origin.created_at+interval '24 hours'\n          ORDER BY r.created_at,r.id LIMIT 1\n        ) earlier_reply ON true\n        WHERE earlier_entry.contact_id=c.id AND earlier_entry.source_type='ad'\n          AND (earlier_entry.meta_ad_id IS NOT NULL OR earlier_entry.ctwa_clid IS NOT NULL)\n          AND earlier_entry.origin_message_id<>entry.origin_message_id\n          AND earlier_reply.created_at<reply.created_at\n          AND earlier_reply.created_at>reply.created_at-interval '168 hours'\n          AND (\n            (c.whatsapp_sender_id=1 AND EXISTS (\n              SELECT 1 FROM whatsapp_free_entry_pricing_evidence old_price\n              WHERE old_price.wamid=earlier_reply.whatsapp_message_id\n                AND old_price.pricing_type='free_entry_point'\n                AND old_price.billable=false\n                AND old_price.delivery_status IN ('sent','delivered','read')\n            )) OR (c.whatsapp_sender_id=2 AND EXISTS (\n              SELECT 1 FROM whatsapp_sender_status_receipts old_price\n              WHERE old_price.sender_id=2\n                AND old_price.wamid=earlier_reply.whatsapp_message_id\n                AND old_price.matched=true\n                AND old_price.pricing_type='free_entry_point'\n                AND old_price.pricing_billable=false\n                AND old_price.delivery_status IN ('sent','delivered','read')\n            ) AND EXISTS (\n              SELECT 1 FROM whatsapp_sender_conversations older_sc\n              JOIN whatsapp_sender_message_context older_inc\n                ON older_inc.conversation_id=older_sc.id\n                AND older_inc.message_id=earlier_entry.origin_message_id\n              JOIN whatsapp_sender_message_context older_sent\n                ON older_sent.conversation_id=older_sc.id\n                AND older_sent.message_id=earlier_reply.id\n              WHERE older_sc.contact_id=c.id AND older_sc.sender_id=2\n                AND older_sc.state='bound'\n            ))\n          )\n      )\n      AND now()<reply.created_at+interval '167 hours'\n      AND (\n        (c.whatsapp_sender_id=1 AND EXISTS (\n          SELECT 1 FROM whatsapp_free_entry_pricing_evidence priced\n          WHERE priced.wamid=reply.whatsapp_message_id\n            AND priced.pricing_type='free_entry_point'\n            AND priced.billable=false\n            AND priced.delivery_status IN ('sent','delivered','read')\n        )) OR (c.whatsapp_sender_id=2 AND EXISTS (\n          SELECT 1 FROM whatsapp_sender_status_receipts priced\n          WHERE priced.sender_id=2 AND priced.wamid=reply.whatsapp_message_id\n            AND priced.matched=true AND priced.pricing_type='free_entry_point'\n            AND priced.pricing_billable=false\n            AND priced.delivery_status IN ('sent','delivered','read')\n        ) AND EXISTS (\n          SELECT 1 FROM whatsapp_sender_conversations sc\n          JOIN whatsapp_sender_message_context inc\n            ON inc.conversation_id=sc.id AND inc.message_id=entry.origin_message_id\n          JOIN whatsapp_sender_message_context sent\n            ON sent.conversation_id=sc.id AND sent.message_id=reply.id\n          WHERE sc.contact_id=c.id AND sc.sender_id=2 AND sc.state='bound'\n        ))\n      )\n    ORDER BY reply.created_at,reply.id LIMIT 1\n  ) session ON true\n  JOIN LATERAL (\n    SELECT m.created_at,m.content FROM messages m\n    WHERE m.contact_id=c.id AND m.role='user'\n    ORDER BY m.created_at DESC,m.id DESC LIMIT 1\n  ) inbound ON true\n  WHERE c.whatsapp_number IS NOT NULL\n    AND COALESCE(c.mode,'ai')<>'human' AND c.needs_attention IS FALSE\n    AND c.whatsapp_opt_in_at IS NOT NULL\n    AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL\n    AND c.whatsapp_opt_out_at IS NULL\n    AND c.whatsapp_marketing_opt_out_at IS NULL\n    AND l.marketing_consent='opted_in' AND l.is_closed=false\n    AND COALESCE(l.appointment_status,'none') NOT IN ('set','visited','booked','confirmed')\n    AND COALESCE(stage.stage_type,'open')='open'\n    AND COALESCE(stage.system_key,'') NOT IN ('appointment_set','visited','confirmed','booked','completed')\n    AND EXISTS (\n      SELECT 1 FROM whatsapp_marketing_consent_events e\n      JOIN messages cm ON cm.id=e.message_id AND cm.contact_id=c.id\n        AND cm.role='user' AND cm.whatsapp_message_id IS NOT NULL\n      WHERE e.contact_id=c.id AND e.consent_category='MARKETING'\n        AND e.consent_scope='treatment_followups_and_related_offers'\n        AND e.consent_service=l.treatment_interest\n        AND e.consented_at>=c.whatsapp_opt_in_at\n        AND (\n          c.whatsapp_sender_id=1 OR EXISTS (\n            SELECT 1 FROM whatsapp_sender_message_context consent_ctx\n            JOIN whatsapp_sender_conversations sc\n              ON sc.id=consent_ctx.conversation_id AND sc.contact_id=c.id\n                AND sc.sender_id=2 AND sc.state='bound'\n            WHERE consent_ctx.message_id=cm.id\n          )\n        )\n    )\n    AND inbound.created_at<now()-interval '24 hours'\n    AND EXISTS (\n      SELECT 1 FROM messages response\n      WHERE response.contact_id=c.id AND response.role='assistant'\n        AND response.whatsapp_message_id IS NOT NULL\n        AND response.created_at>inbound.created_at\n        AND response.delivery_status IS DISTINCT FROM 'failed'\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM messages outgoing\n      WHERE outgoing.contact_id=c.id AND outgoing.role='assistant'\n        AND outgoing.created_at>now()-interval '5 hours'\n        AND outgoing.delivery_status IS DISTINCT FROM 'cancelled'\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM messages staff\n      JOIN users u ON u.username=staff.sent_by_username\n      WHERE staff.contact_id=c.id AND staff.role='assistant'\n        AND staff.created_at>session.first_reply_at\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM sales_follow_up_tasks handled\n      JOIN leads related ON related.id=handled.lead_id\n      WHERE related.contact_id=c.id AND handled.updated_at>=session.first_reply_at\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM messages declined\n      WHERE declined.contact_id=c.id AND declined.role='user'\n        AND declined.created_at>=session.first_reply_at\n        AND coalesce(declined.content,'') ~* '(stop|unsubscribe|not interested|no thanks|next year|以后再说|暂时先不用|暫時先不用|不要|没兴趣|沒興趣|不需要|tak berminat|jangan hantar)'\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM messages sent_promo\n      WHERE sent_promo.contact_id=c.id AND sent_promo.role='assistant'\n        AND sent_promo.whatsapp_template->>'name'='ns_3d_1111_rm388_2026'\n    )\n    AND now()<TIMESTAMPTZ '2026-11-30T15:59:59Z'\n)\nSELECT contact_id,sender_id,recipient_key,contact_name,treatment_interest,first_reply_at,safe_expires_at,suggested_language,blocked_reason\nFROM candidates";

async function candidates(database = pool) {
  const result = await database.query(
    `SELECT qualified.*,
      EXISTS (
        SELECT 1 FROM whatsapp_promotional_blast_claims claim
        WHERE claim.campaign_key=$1 AND claim.recipient_key=qualified.recipient_key
      ) AS already_claimed
    FROM (${CANDIDATE_SQL}) qualified
    ORDER BY qualified.safe_expires_at ASC, qualified.contact_id ASC LIMIT 100`,
    [CAMPAIGN_KEY]
  );
  return result.rows || [];
}

async function claimRecipient(contactId, languageCode, staffUsername, database = pool) {
  if (!Number.isSafeInteger(contactId) || contactId <= 0 ||
      !LANGUAGES.has(languageCode) || !staffUsername) return null;
  const result = await database.query(
    `INSERT INTO whatsapp_promotional_blast_claims
      (campaign_key,contact_id,recipient_key,sender_id,language_code,staff_username)
    SELECT $1,qualified.contact_id,qualified.recipient_key,
      qualified.sender_id,$3,$4
    FROM (${CANDIDATE_SQL}) qualified
    WHERE qualified.contact_id=$2 AND qualified.blocked_reason IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_promotional_blast_claims prior
        WHERE prior.campaign_key=$1 AND prior.recipient_key=qualified.recipient_key
      )
    ON CONFLICT DO NOTHING
    RETURNING id,contact_id`,
    [CAMPAIGN_KEY,contactId,languageCode,staffUsername]
  );
  return result.rows?.[0] || null;
}

// Irreversibly consume a claim before the existing template send path.
// This prevents refresh, double-click and ambiguous delivery from causing
// the browser to transmit another campaign message.
async function consumeClaim(contactId, campaignKey, languageCode, staffUsername, database = pool) {
  if (campaignKey !== CAMPAIGN_KEY || !LANGUAGES.has(languageCode) || !staffUsername) return false;
  const result = await database.query(
    `UPDATE whatsapp_promotional_blast_claims claim
    SET state='attempted', attempted_at=now()
    FROM (${CANDIDATE_SQL}) qualified
    WHERE claim.campaign_key=$1 AND claim.contact_id=$2
      AND claim.staff_username=$3 AND claim.language_code=$4
      AND claim.state='reserved'
      AND qualified.contact_id=claim.contact_id
      AND qualified.recipient_key=claim.recipient_key
      AND qualified.blocked_reason IS NULL
    RETURNING claim.id`,
    [CAMPAIGN_KEY,contactId,staffUsername,languageCode]
  );
  return result.rows?.length === 1;
}

module.exports = {
  CAMPAIGN_KEY, CAMPAIGN_LABEL, LANGUAGES,
  CANDIDATE_SQL, candidates, claimRecipient, consumeClaim,
};
