"use strict";

// Phase 2B: read-only, sender-qualified policy evaluation. No outbound path
// imports this file yet. An "allowed" policy result is never permission to
// call Graph API: billing and receipt reconciliation are a separate gate.
const { pool } = require("../db/db");

const POLICY_MARGIN_MS = 2 * 60 * 1000;
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const GRAPH_API_VERSION = "v26.0";
const TEMPLATE_CATEGORIES = new Set(["UTILITY", "MARKETING", "AUTHENTICATION"]);

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function numeric(value) { return /^[0-9]+$/.test(clean(value)); }
function deny(code) {
  return { policyAllowed: false, sendAuthorized: false, code };
}
function readyForEvaluation(env) {
  return env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true" &&
    env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED === "true";
}

const SECONDARY_POLICY_SNAPSHOT_SQL = `
  SELECT c.id, c.channel, c.whatsapp_number, c.whatsapp_sender_id,
         c.whatsapp_opt_in_at, c.whatsapp_opt_in_source,
         c.whatsapp_opt_out_at, c.whatsapp_marketing_opt_out_at,
         sc.id AS sender_conversation_id, sc.state AS binding_state,
         sc.customer_wa_id, sa.sender_key, sa.meta_phone_number_id,
         sa.meta_account_id, sa.state AS sender_state,
         (
           SELECT MAX(COALESCE(m.source_created_at,m.created_at))
           FROM messages m
           JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
             AND mc.conversation_id=sc.id
           WHERE m.contact_id=c.id AND m.role='user'
             AND m.whatsapp_message_id IS NOT NULL
         ) AS latest_inbound_at
  FROM contacts c
  JOIN whatsapp_sender_conversations sc
    ON sc.contact_id=c.id AND sc.sender_id=c.whatsapp_sender_id
  JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id
  WHERE c.id=$1 AND c.channel='whatsapp'
    AND c.whatsapp_number=$2
    AND sc.customer_wa_id=c.whatsapp_number AND sc.state='bound'
    AND sa.state='active'
    AND sa.sender_key=$3 AND sa.meta_phone_number_id=$4
    AND sa.meta_account_id=$5
`;

async function secondaryPolicySnapshot(contact, { database = pool, env = process.env } = {}) {
  if (!readyForEvaluation(env)) return deny("secondary_policy_disabled");
  const id = Number(contact?.id);
  if (!Number.isSafeInteger(id) || id <= 0 ||
      contact?.channel !== "whatsapp" ||
      !/^[0-9]{8,15}$/.test(clean(contact.whatsapp_number)) ||
      !numeric(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
      !numeric(env.WHATSAPP_SECONDARY_WABA_ID) ||
      !numeric(env.WHATSAPP_PHONE_NUMBER_ID) ||
      !numeric(env.WHATSAPP_WABA_ID) ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(clean(env.WHATSAPP_SECONDARY_SENDER_KEY)) ||
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID === env.WHATSAPP_PHONE_NUMBER_ID ||
      env.WHATSAPP_SECONDARY_SENDER_KEY === env.WHATSAPP_PRIMARY_SENDER_KEY) {
    return deny("secondary_sender_not_verified");
  }
  if ((contact.whatsapp_sender_key &&
       contact.whatsapp_sender_key !== env.WHATSAPP_SECONDARY_SENDER_KEY) ||
      (contact.whatsapp_sender_phone_number_id &&
       contact.whatsapp_sender_phone_number_id !== env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
      (contact.whatsapp_sender_account_id &&
       contact.whatsapp_sender_account_id !== env.WHATSAPP_SECONDARY_WABA_ID)) {
    return deny("secondary_sender_mismatch");
  }
  try {
    const result = await database.query(SECONDARY_POLICY_SNAPSHOT_SQL, [
      id, contact.whatsapp_number, env.WHATSAPP_SECONDARY_SENDER_KEY,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env.WHATSAPP_SECONDARY_WABA_ID,
    ]);
    if (result.rows?.length !== 1) return deny("secondary_sender_not_bound");
    const row = result.rows[0];
    if (!row.whatsapp_sender_id ||
        String(row.whatsapp_sender_id) === "0" ||
        row.sender_state !== "active" ||
        row.binding_state !== "bound" ||
        row.sender_key !== env.WHATSAPP_SECONDARY_SENDER_KEY ||
        row.meta_phone_number_id !== env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID ||
        row.meta_account_id !== env.WHATSAPP_SECONDARY_WABA_ID ||
        row.whatsapp_number !== contact.whatsapp_number ||
        row.customer_wa_id !== contact.whatsapp_number) {
      return deny("secondary_sender_not_bound");
    }
    return { row, policyAllowed: false, sendAuthorized: false };
  } catch {
    return deny("secondary_policy_database_unavailable");
  }
}

function validTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function evaluateServiceWindow(row, now, { purpose = "service" } = {}) {
  if (purpose !== "service") return deny("secondary_marketing_requires_template");
  const current = validTime(now);
  const latest = validTime(row.latest_inbound_at);
  if (!current) return deny("invalid_policy_time");
  if (!latest || latest.getTime() > current.getTime() + POLICY_MARGIN_MS) {
    return deny("secondary_no_verified_inbound");
  }
  const optOut = validTime(row.whatsapp_opt_out_at);
  if (row.whatsapp_opt_out_at && !optOut) return deny("invalid_opt_out_timestamp");
  if (optOut && latest.getTime() <= optOut.getTime()) return deny("secondary_opted_out");
  const endsAt = new Date(latest.getTime() + SERVICE_WINDOW_MS);
  if (current.getTime() + POLICY_MARGIN_MS >= endsAt.getTime()) {
    return deny("secondary_service_window_closed");
  }
  return {
    policyAllowed: true,
    sendAuthorized: false,
    code: null,
    windowEndsAt: endsAt.toISOString(),
  };
}

// This is a read-only policy result. It does NOT reserve billing, check Meta
// approval, or allow any provider call.
async function previewSecondaryFreeformPolicy(contact, {
  database = pool, env = process.env, now = new Date(), purpose = "service",
} = {}) {
  const binding = await secondaryPolicySnapshot(contact, { database, env });
  if (!binding.row) return binding;
  return evaluateServiceWindow(binding.row, now, { purpose });
}

const SECONDARY_MARKETING_CONSENT_SQL = `
  WITH active_lead AS (
    SELECT l.id, l.marketing_consent, l.treatment_interest
    FROM leads l WHERE l.contact_id=$1
    ORDER BY l.is_closed ASC,l.created_at DESC,l.id DESC LIMIT 1
  )
  SELECT l.marketing_consent, EXISTS (
    SELECT 1 FROM whatsapp_marketing_consent_events e
    LEFT JOIN messages m ON m.id=e.message_id AND m.contact_id=$1
      AND m.role='user' AND m.whatsapp_message_id=e.provider_message_id
    LEFT JOIN whatsapp_sender_message_context mc
      ON mc.message_id=m.id AND mc.conversation_id=$2
    WHERE e.contact_id=$1
      AND e.created_at >= $3::timestamptz
      AND (
        (e.message_id IS NOT NULL AND mc.message_id IS NOT NULL
          AND e.consent_category='MARKETING'
          AND e.consented_at=$3::timestamptz
          AND e.consent_scope='treatment_followups_and_related_offers'
          AND NULLIF(BTRIM(e.consent_service),'') IS NOT NULL
          AND NULLIF(BTRIM(l.treatment_interest),'') IS NOT NULL
          AND LOWER(BTRIM(e.consent_service))=LOWER(BTRIM(l.treatment_interest))
          AND ($4::text IS NULL OR
               LOWER(BTRIM(e.consent_service))=LOWER(BTRIM($4::text))))
        OR
        (e.message_id IS NULL AND e.lead_id=l.id
          AND e.consent_scope IS NULL
          AND NULLIF(BTRIM(e.source),'') IS NOT NULL)
      )
  ) AS verified
  FROM active_lead l
`;

// Template lookup is always made against Ariel's own verified WABA and token.
// No shared Neutro catalog, name-only cached result, or caller-asserted approval.
async function verifySecondaryApprovedTemplate({
  name, languageCode, contact, database = pool, env = process.env,
  fetchImpl = global.fetch,
} = {}) {
  const binding = await secondaryPolicySnapshot(contact, { database, env });
  if (!binding.row) return binding;
  if (!/^[a-z0-9_]+$/.test(clean(name)) ||
      !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(clean(languageCode)) ||
      !clean(env.WHATSAPP_SECONDARY_TOKEN) ||
      typeof fetchImpl !== "function") return deny("secondary_template_not_configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL("https://graph.facebook.com/" + GRAPH_API_VERSION +
      "/" + env.WHATSAPP_SECONDARY_WABA_ID + "/message_templates");
    url.searchParams.set("name", name);
    url.searchParams.set("fields", "name,language,status,category");
    url.searchParams.set("limit", "100");
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: "Bearer " + env.WHATSAPP_SECONDARY_TOKEN },
      signal: controller.signal,
    });
    if (!response.ok) return deny("secondary_template_catalog_unavailable");
    const payload = await response.json();
    if (!Array.isArray(payload?.data) || payload.paging?.next) {
      // Paginated response is incomplete; no unsafe partial approval.
      return deny("secondary_template_catalog_incomplete");
    }
    const matched = payload.data.filter(t =>
      t?.name === name && t?.language === languageCode &&
      t?.status === "APPROVED" && TEMPLATE_CATEGORIES.has(t?.category));
    if (matched.length !== 1) return deny("secondary_template_not_approved");
    return { policyAllowed: false, sendAuthorized: false, template: {
      name, languageCode, category: matched[0].category,
    }};
  } catch {
    return deny("secondary_template_catalog_unavailable");
  } finally {
    clearTimeout(timer);
  }
}

// Called only by a future sender-specific dispatcher after the Graph catalog,
// consent and billing integration exists. It remains read-only today.
async function previewSecondaryTemplatePolicy(contact, {
  name, languageCode, treatmentInterest = null, env = process.env,
  database = pool, fetchImpl = global.fetch, now = new Date(),
} = {}) {
  const binding = await secondaryPolicySnapshot(contact, { env, database });
  if (!binding.row) return binding;
  const row = binding.row;
  const current = validTime(now);
  const optInAt = validTime(row.whatsapp_opt_in_at);
  if (!current) return deny("invalid_policy_time");
  if (row.whatsapp_opt_out_at) return deny("secondary_opted_out");
  if (!optInAt || optInAt.getTime() > current.getTime() ||
      !clean(row.whatsapp_opt_in_source)) return deny("secondary_missing_opt_in");
  const approval = await verifySecondaryApprovedTemplate({
    name, languageCode, contact, env, database, fetchImpl,
  });
  if (!approval.template) return approval;
  if (approval.template.category === "MARKETING") {
    if (row.whatsapp_marketing_opt_out_at) return deny("secondary_marketing_opted_out");
    try {
      const consent = await database.query(SECONDARY_MARKETING_CONSENT_SQL, [
        Number(contact.id), row.sender_conversation_id, optInAt.toISOString(),
        clean(treatmentInterest) || null,
      ]);
      const evidence = consent.rows?.[0];
      if (consent.rows?.length !== 1 || evidence.marketing_consent !== "opted_in" ||
          evidence.verified !== true) return deny("secondary_marketing_consent_unverified");
    } catch {
      return deny("secondary_consent_database_unavailable");
    }
  }
  return {
    policyAllowed: true,
    sendAuthorized: false,
    code: null,
    template: approval.template,
  };
}

// Priced CTWA evidence is read ONLY for this verified conversation and exact
// receiving WABA/phone. It is informational until the billing reconciliation
// worker and reservation gate are connected.
const SECONDARY_CTWA_EVIDENCE_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM whatsapp_free_entry_referrals entry
    JOIN messages inbound ON inbound.id=entry.origin_message_id
      AND inbound.contact_id=$1 AND inbound.role='user'
      AND inbound.whatsapp_message_id IS NOT NULL
    JOIN whatsapp_sender_message_context inc ON inc.message_id=inbound.id
      AND inc.conversation_id=$2
    JOIN LATERAL (
      SELECT r.id,r.whatsapp_message_id,r.created_at
      FROM messages r
      JOIN whatsapp_sender_message_context rmc ON rmc.message_id=r.id
        AND rmc.conversation_id=$2
      WHERE r.contact_id=$1 AND r.role='assistant'
        AND r.whatsapp_message_id IS NOT NULL
        AND r.created_at>=inbound.created_at
        AND r.created_at<inbound.created_at+interval '24 hours'
      ORDER BY r.created_at,r.id LIMIT 1
    ) reply ON true
    JOIN whatsapp_free_entry_pricing_evidence priced
      ON priced.wamid=reply.whatsapp_message_id
      AND priced.business_phone_number_id=$3
      AND priced.business_account_id=$4
      AND priced.pricing_type='free_entry_point'
      AND priced.billable=false
      AND priced.delivery_status IN ('sent','delivered','read')
    WHERE entry.contact_id=$1 AND entry.source_type='ad'
      AND (entry.ctwa_clid IS NOT NULL OR entry.meta_ad_id IS NOT NULL)
      AND reply.created_at <= $5::timestamptz
      AND reply.created_at > $5::timestamptz - interval '71 hours'
  ) AS verified
`;

async function inspectSecondaryCtwaEvidence(contact, {
  env = process.env, database = pool, now = new Date(),
} = {}) {
  const binding = await secondaryPolicySnapshot(contact, { env, database });
  if (!binding.row) return { ...binding, verified: false };
  const current = validTime(now);
  if (!current) return { ...deny("invalid_policy_time"), verified: false };
  try {
    const result = await database.query(SECONDARY_CTWA_EVIDENCE_SQL, [
      Number(contact.id), binding.row.sender_conversation_id,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env.WHATSAPP_SECONDARY_WABA_ID,
      current.toISOString(),
    ]);
    return { verified: result.rows?.length === 1 && result.rows[0].verified === true,
      sendAuthorized: false };
  } catch {
    return { ...deny("secondary_ctwa_database_unavailable"), verified: false };
  }
}

module.exports = {
  SECONDARY_POLICY_SNAPSHOT_SQL,
  SECONDARY_MARKETING_CONSENT_SQL,
  SECONDARY_CTWA_EVIDENCE_SQL,
  secondaryPolicySnapshot,
  evaluateServiceWindow,
  previewSecondaryFreeformPolicy,
  previewSecondaryTemplatePolicy,
  verifySecondaryApprovedTemplate,
  inspectSecondaryCtwaEvidence,
};
