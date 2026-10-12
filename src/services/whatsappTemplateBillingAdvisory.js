"use strict";

const crypto = require("node:crypto");
const { pool } = require("../db/db");
const whatsappZeroCostGuard = require("./whatsappZeroCostGuard");

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
(SELECT c.whatsapp_number FROM contacts c
 WHERE c.id=$1 AND c.channel='whatsapp') AS recipient,
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
  now = new Date(), env = process.env, templateName, languageCode,
} = {}) {
  const secret = secretForReview(env);
  if (!VALID_EVIDENCE.has(evidence) || !Number.isSafeInteger(Number(contactId)) ||
      Number(contactId) <= 0 || !String(staffUsername || "").trim()) {
    throw new Error("Invalid billing review context.");
  }
  if (!String(templateName || "").trim() || !String(languageCode || "").trim()) {
    throw new Error("A billing review must identify the exact template and language.");
  }
  const payload = Buffer.from(JSON.stringify({
    v: 2, contactId: Number(contactId), staff: String(staffUsername),
    evidence, issuedAt: new Date(now).getTime(),
    templateName: String(templateName), languageCode: String(languageCode),
    nonce: crypto.randomUUID(),
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + signature;
}

function verifyReviewToken(token, contactId, staffUsername, {
  now = new Date(), env = process.env, templateName, languageCode,
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
    if (review.v !== 2 || review.contactId !== Number(contactId) ||
        review.staff !== String(staffUsername || "") ||
        review.templateName !== String(templateName || "") ||
        review.languageCode !== String(languageCode || "") ||
        typeof review.nonce !== "string" || review.nonce.length < 32 ||
        !VALID_EVIDENCE.has(review.evidence) ||
        !Number.isSafeInteger(review.issuedAt) || age < 0 || age > REVIEW_TTL_MS) return null;
    return review;
  } catch { return null; }
}

async function getTemplateBillingAdvisory(contactId, {
  database = pool, now = new Date(), staffUsername = null, env = process.env,
  templates = [],
} = {}) {
  const id = Number(contactId);
  if (!Number.isSafeInteger(id) || id <= 0) return { evidence: "unknown" };
  let evidence = "unknown";
  let freeEntry = { verified: false, sendReady: false, blockedReason: null };
  try {
    const result = await database.query(BILLING_ADVISORY_SQL, [id, now]);
    const row = result.rows?.[0];
    // Both displays use the same receipt and seven-day evidence. An account
    // gate can pause sending without revoking the underlying free period.
    // A recent charged message still takes precedence over the free indicator.
    if (row?.has_ctwa_referral === true &&
        row?.has_recent_billable_message !== true && row?.recipient) {
      freeEntry = await whatsappZeroCostGuard.inspectFreeTemplateWindow(
        row.recipient, { database, now, env }
      );
    }
    evidence = row ? describeEvidence({
      ...row,
      has_recent_verified_free_entry: freeEntry.verified,
    }) : "unknown";
  } catch (error) {
    // Fail conservatively: staff must still explicitly acknowledge a possible
    // charge when the pricing-evidence database is temporarily unavailable.
    console.warn("[WhatsApp template billing] Evidence unavailable:", error?.message);
  }
  return {
    evidence,
    freeEntry,
    reviewedAt: new Date(now).toISOString(),
    // Separate tokens for each approved template language. A token may never
    // be reused for a different template, even via a forged direct API call.
    reviewTokens: Object.fromEntries(templates
      .filter((template) => template?.sendable === true &&
        template.name && template.language)
      .map((template) => [
        template.name + "::" + template.language,
        issueReviewToken(id, staffUsername, evidence, {
          now, env, templateName: template.name, languageCode: template.language,
        }),
      ])),
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
  const templateName = String(body?.templateName || "").trim();
  const languageCode = String(body?.languageCode || "").trim();
  const original = verifyReviewToken(body?.billingReviewToken, contactId,
    staffUsername, { now, env, templateName, languageCode });
  const current = await getTemplateBillingAdvisory(contactId, {
    database, now, env, staffUsername,
    templates: templateName && languageCode ? [
      { name: templateName, language: languageCode, sendable: true },
    ] : [],
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

// The INSERT claim is atomic on Neon/Postgres and survives process restarts.
// NEVER release a claim if Meta outcome is unknown or a write partially fails.
async function claimBillingReviewOnce(contactId, staffUsername, body, {
  database = pool, now = new Date(), env = process.env,
} = {}) {
  const review = verifyReviewToken(body?.billingReviewToken, contactId,
    staffUsername, {
      now, env,
      templateName: body?.templateName, languageCode: body?.languageCode,
    });
  if (!review || (body?.billingAcknowledged !== true &&
      body?.billingAcknowledged !== "true")) {
    return { claimed: false, code: "billing_review_expired" };
  }
  const tokenHash = crypto.createHash("sha256")
    .update(body.billingReviewToken).digest("hex");
  const result = await database.query(
    `INSERT INTO whatsapp_manual_template_billing_claims
     (token_hash,contact_id,staff_username,template_name,language_code)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING token_hash`,
    [tokenHash, Number(contactId), String(staffUsername),
      review.templateName, review.languageCode]
  );
  return result.rows?.length === 1
    ? { claimed: true, tokenHash }
    : { claimed: false, code: "billing_review_already_used" };
}

module.exports = {
  BILLING_ADVISORY_SQL, REVIEW_TTL_MS,
  describeEvidence, issueReviewToken, verifyReviewToken,
  getTemplateBillingAdvisory, validateBillingAcknowledgment,
  claimBillingReviewOnce,
};
