"use strict";

const crypto = require("node:crypto");
const { pool } = require("../db/db");

// A billing advisory is not a Meta price quote and NEVER guarantees RM0.
// Recent billable messages take priority over any earlier free-entry evidence.
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
    -- Conservative 72-hour horizon; later periods need separate verification.
    AND $2::timestamptz<first_reply.created_at+interval '71 hours'
) AS has_recent_verified_free_entry,
EXISTS (
  SELECT 1 FROM messages m
  JOIN whatsapp_free_entry_pricing_evidence billed
    ON billed.wamid=m.whatsapp_message_id
  WHERE m.contact_id=$1 AND m.role='assistant'
    AND billed.billable=true
    AND billed.delivery_status IN ('sent','delivered','read')
    AND m.created_at>=$2::timestamptz-interval '7 days'
    AND m.created_at<=$2::timestamptz
) AS has_recent_billable_message
`;

const REVIEW_TTL_MS = 3 * 60 * 1000;
const VALID_EVIDENCE = new Set([
  "recent_billable_message", "recent_free_entry_evidence",
  "ctwa_unverified_or_expired", "no_ctwa_referral", "unknown",
]);

function describeEvidence(row) {
  if (!row) return "unknown";
  if (row.has_recent_billable_message === true) return "recent_billable_message";
  if (row.has_recent_verified_free_entry === true) return "recent_free_entry_evidence";
  if (row.has_ctwa_referral === true) return "ctwa_unverified_or_expired";
  return "no_ctwa_referral";
}

// Use the clinic's existing strong session secret; no extra credential is stored
// and a token from one staff account/contact cannot authorize another.
function secretForReview(env = process.env) {
  const secret = String(env.SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("Billing review signing secret is unavailable.");
  return secret;
}

function issueReviewToken(contactId, staffUsername, evidence, {
  now = new Date(), env = process.env,
} = {}) {
  const secret = secretForReview(env);
  if (!VALID_EVIDENCE.has(evidence) || !Number.isSafeInteger(Number(contactId)) ||
      Number(contactId) <= 0 || !String(staffUsername || "").trim()) {
    throw new Error("Invalid billing review context.");
  }
  const payload = Buffer.from(JSON.stringify({
    v: 1, contactId: Number(contactId), staff: String(staffUsername),
    evidence, issuedAt: new Date(now).getTime(),
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + signature;
}

function verifyReviewToken(token, contactId, staffUsername, {
  now = new Date(), env = process.env,
} = {}) {
  if (typeof token !== "string" || token.length > 2048 || token.length < 40) return null;
  const pieces = token.split(".");
  if (pieces.length !== 2 || !pieces.every(Boolean)) return null;
  const expected = crypto.createHmac("sha256", secretForReview(env))
    .update(pieces[0]).digest();
  let supplied;
  try { supplied = Buffer.from(pieces[1], "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const review = JSON.parse(Buffer.from(pieces[0], "base64url").toString("utf8"));
    const age = new Date(now).getTime() - review.issuedAt;
    if (review.v !== 1 || review.contactId !== Number(contactId) ||
        review.staff !== String(staffUsername || "") ||
        !VALID_EVIDENCE.has(review.evidence) ||
        !Number.isSafeInteger(review.issuedAt) || age < 0 || age > REVIEW_TTL_MS) return null;
    return review;
  } catch { return null; }
}

async function getTemplateBillingAdvisory(contactId, {
  database = pool, now = new Date(), staffUsername = null, env = process.env,
} = {}) {
  const id = Number(contactId);
  if (!Number.isSafeInteger(id) || id <= 0) return { evidence: "unknown" };
  let evidence = "unknown";
  try {
    const result = await database.query(BILLING_ADVISORY_SQL, [id, now]);
    evidence = describeEvidence(result.rows?.[0]);
  } catch (error) {
    // Fail conservatively: staff must still explicitly acknowledge a possible
    // charge when the pricing-evidence database is temporarily unavailable.
    console.warn("[WhatsApp template billing] Evidence unavailable:", error?.message);
  }
  return {
    evidence,
    reviewedAt: new Date(now).toISOString(),
    reviewToken: issueReviewToken(id, staffUsername, evidence, { now, env }),
  };
}

async function validateBillingAcknowledgment(contactId, staffUsername, body, {
  now = new Date(), env = process.env, database = pool,
} = {}) {
  if (body?.billingAcknowledged !== true &&
      body?.billingAcknowledged !== "true") {
    return {
      allowed: false, code: "billing_acknowledgment_required", status: 400,
      error: "Review the possible Meta charge and confirm it before sending this template.",
    };
  }
  const original = verifyReviewToken(body?.billingReviewToken, contactId,
    staffUsername, { now, env });
  const current = await getTemplateBillingAdvisory(contactId, {
    database, now, env, staffUsername,
  });
  if (!original || original.evidence !== current.evidence) {
    return {
      allowed: false,
      code: original ? "billing_evidence_changed" : "billing_review_expired",
      status: 409,
      error: original
        ? "Meta billing evidence changed. Review the updated warning and confirm the possible charge again."
        : "Billing review expired or was invalid. Review the current warning and confirm again.",
      billingAdvisory: current,
    };
  }
  return { allowed: true, evidence: current.evidence, reviewedAt: current.reviewedAt };
}

module.exports = {
  BILLING_ADVISORY_SQL, REVIEW_TTL_MS,
  describeEvidence, issueReviewToken, verifyReviewToken,
  getTemplateBillingAdvisory, validateBillingAcknowledgment,
};
