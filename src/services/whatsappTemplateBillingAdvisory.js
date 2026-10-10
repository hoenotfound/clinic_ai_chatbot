"use strict";

const { pool } = require("../db/db");

// This is a staff-facing billing *advisory*, not a pre-send Meta quote.
// An ad click is not enough: require the actual first business reply and
// Meta's non-billable free-entry pricing callback for recent evidence.
const BILLING_ADVISORY_SQL = `
SELECT EXISTS (
  SELECT 1
  FROM whatsapp_free_entry_referrals entry
  WHERE entry.contact_id=$1
    AND entry.source_type='ad'
    AND (NULLIF(BTRIM(entry.ctwa_clid),'') IS NOT NULL
      OR NULLIF(BTRIM(entry.meta_ad_id),'') IS NOT NULL)
) AS has_ctwa_referral,
EXISTS (
  SELECT 1
  FROM whatsapp_free_entry_referrals entry
  JOIN messages inbound ON inbound.id=entry.origin_message_id
    AND inbound.contact_id=entry.contact_id AND inbound.role='user'
  JOIN LATERAL (
    SELECT reply.created_at, reply.whatsapp_message_id
    FROM messages reply
    WHERE reply.contact_id=entry.contact_id AND reply.role='assistant'
      AND reply.whatsapp_message_id IS NOT NULL
      AND reply.created_at>=inbound.created_at
      AND reply.created_at<inbound.created_at+interval '24 hours'
    ORDER BY reply.created_at,reply.id LIMIT 1
  ) first_reply ON TRUE
  JOIN whatsapp_free_entry_pricing_evidence evidence
    ON evidence.wamid=first_reply.whatsapp_message_id
    AND evidence.pricing_type='free_entry_point'
    AND evidence.billable=false
    AND evidence.delivery_status IN ('sent','delivered','read')
  WHERE entry.contact_id=$1 AND entry.source_type='ad'
    AND (NULLIF(BTRIM(entry.ctwa_clid),'') IS NOT NULL
      OR NULLIF(BTRIM(entry.meta_ad_id),'') IS NOT NULL)
    AND first_reply.created_at<=$2::timestamptz
    -- One-hour safety margin and conservative 72-hour evidence horizon.
    -- Never promise 7-day eligibility from an environment flag.
    AND $2::timestamptz<first_reply.created_at+interval '71 hours'
) AS has_recent_verified_free_entry
`;

function describeEvidence(row) {
  if (!row) return "unknown";
  if (row.has_recent_verified_free_entry === true) return "recent_free_entry_evidence";
  if (row.has_ctwa_referral === true) return "ctwa_unverified_or_expired";
  return "no_ctwa_referral";
}

async function getTemplateBillingAdvisory(contactId, {
  database = pool,
  now = new Date(),
} = {}) {
  const id = Number(contactId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { evidence: "unknown" };
  }
  const result = await database.query(BILLING_ADVISORY_SQL, [id, now]);
  return { evidence: describeEvidence(result.rows?.[0]) };
}

module.exports = {
  BILLING_ADVISORY_SQL,
  describeEvidence,
  getTemplateBillingAdvisory,
};
