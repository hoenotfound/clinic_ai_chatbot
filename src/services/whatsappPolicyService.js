const { pool } = require("../db/db");
const { humanAgentChannelEnabled } = require("../utils/metaHumanAgent");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STANDARD_WINDOW_CHANNELS = new Set(["whatsapp", "facebook", "instagram"]);
const HUMAN_AGENT_CHANNELS = new Set(["facebook", "instagram"]);

const GLOBAL_OPT_OUT_PATTERNS = [
  /^stop$/i,
  /^unsubscribe$/i,
  /^remove me$/i,
  /^no more messages?$/i,
  /^don['’]?t (?:message|whatsapp|contact) me$/i,
  /^(?:please )?stop (?:message|messaging|whatsapp|contacting) me$/i,
  /^please don['’]?t (?:message|whatsapp|contact) me$/i,
  /^不要再发(?:消息)?$/,
  /^不要联系我$/,
  /^停止(?:消息|联系)?$/,
  /^jangan (?:mesej|whatsapp|hubungi) saya$/i,
  /^tak nak (?:mesej|whatsapp)$/i,
  /^stop mesej$/i,
  /^unsubscribe from all$/i,
  /^unsubcribe from all$/i,
  /^stop all$/i,
];

const MARKETING_OPT_OUT_PATTERNS = [
  /^stop (?:promos?|promotions?)$/i,
  /^unsub(?:scribe|cribe) from (?:promos?|promotions?)$/i,
  /^(?:please\s+)?(?:stop|don't|do not)\s+(?:(?:sending?|send)\s+(?:me\s+)?)?(?:any\s+)?(?:marketing|promotional|promotions?|promos?|offers?)(?:\s+(?:messages?|updates?|notifications?))?$/i,
  /^(?:please\s+)?(?:unsubscribe|opt out)\s+(?:me\s+)?(?:from\s+)?(?:marketing|promotions?|offers?)$/i,
  /^(?:我)?(?:不想再|不想|不要再|不要|别再|别)(?:收(?:到)?|接收|发|发送|通知)(?:我)?(?:任何)?(?:优惠|優惠|促销|促銷|营销|營銷|推广|推廣)(?:的)?(?:信息|消息|通知)?(?:了)?$/,
  /^(?:saya\s+)?(?:tak\s+mahu|tak\s+nak|tidak\s+mahu)\s+(?:terima\s+)?(?:promosi|tawaran)$/i,
  /^(?:不要|别|請不要|请不要)(?:再)?(?:发|發|发送|發送|通知)(?:我)?(?:优惠|優惠|促销|促銷|推广|推廣)(?:了)?$/,
  /^(?:停止|取消)(?:优惠|優惠|促销|促銷|推广|推廣)(?:通知|消息)?$/,
  /^(?:jangan (?:hantar|kirim|mesej) (?:saya )?(?:promosi|tawaran)|tak nak (?:promosi|tawaran))$/i,
];

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/[.!！。?？]+$/g, "")
    .replace(/\s+/g, " ");
}

function classifyOptOutText(value) {
  const text = normalizeText(value);
  if (!text) return null;
  // Free-form opt-outs often contain politeness, punctuation or explanatory
  // clauses. Restrict these to a clear refusal AND a promotional subject.
  // An ordinary enquiry mentioning "offers" must never be classified as STOP.
  const refusePromotion =
    /(?:stop|don't|do not|no more|unsubscribe|opt out|remove me|not interested in|avoid sending)\b.{0,100}\b(?:promo(?:tion)?s?|offers?|marketing|discounts?|deals?|ads?)\b/i.test(text) ||
    /(?:不要|别|不想|不需要|停止|取消|不用|无需).{0,45}(?:优惠|優惠|促销|促銷|广告|廣告|营销|營銷|推广|推廣|宣传|宣傳)/.test(text) ||
    /(?:优惠|優惠|促销|促銷|广告|廣告|营销|營銷|推广|推廣).{0,28}(?:不要|别发|別發|停止|取消|不用|不需要|不想)/.test(text) ||
    /(?:jangan|tak nak|tak mahu|tidak mahu|berhenti|hentikan|tidak ingin).{0,90}(?:promosi|tawaran|iklan|pemasaran)/i.test(text);
  if (refusePromotion || MARKETING_OPT_OUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "marketing";
  }
  if (GLOBAL_OPT_OUT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "all";
  }
  return null;
}

function isOptOutText(value) {
  return classifyOptOutText(value) !== null;
}

async function getPolicyState(contactId) {
  const result = await pool.query(
    `SELECT
       c.id,
       c.channel,
       c.whatsapp_number,
       c.whatsapp_opt_in_at,
       c.whatsapp_opt_in_source,
       c.whatsapp_opt_out_at,
       c.whatsapp_opt_out_source,
       c.whatsapp_marketing_opt_out_at,
       c.whatsapp_marketing_opt_out_source,
       c.social_opt_out_at,
       c.social_opt_out_source,
       c.social_marketing_opt_out_at,
       c.social_marketing_opt_out_source,
       (
         SELECT COALESCE(m.source_created_at, m.created_at)
         FROM messages m
         WHERE m.contact_id = c.id
           AND m.role = 'user'
         ORDER BY COALESCE(m.source_created_at, m.created_at) DESC, m.id DESC
         LIMIT 1
       ) AS latest_inbound_at
     FROM contacts c
     WHERE c.id = $1`,
    [contactId]
  );
  return result.rows[0] || null;
}

function policyError(code, message, extra = {}) {
  return {
    allowed: false,
    code,
    message,
    ...extra,
  };
}

function channelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return "WhatsApp";
}

function manualStaffPurpose(contactOrChannel, env = process.env) {
  const channel =
    typeof contactOrChannel === "string"
      ? contactOrChannel
      : contactOrChannel?.channel || "whatsapp";
  return humanAgentChannelEnabled(channel, env) && HUMAN_AGENT_CHANNELS.has(channel)
    ? "human_agent"
    : "service";
}

function noCustomerMessageError(channel) {
  if (channel === "whatsapp") {
    return "WhatsApp send blocked because this customer has never messaged the business. Use an approved template only after valid WhatsApp opt-in has been recorded.";
  }
  return `${channelLabel(channel)} send blocked because this customer has never messaged the business.`;
}

function outsideWindowError(channel, humanAgentEnabled = false) {
  if (channel === "whatsapp") {
    return "WhatsApp send blocked because the 24-hour customer-service window has closed. Use an approved template only after valid WhatsApp opt-in has been recorded.";
  }
  if (humanAgentEnabled && HUMAN_AGENT_CHANNELS.has(channel)) {
    return `${channelLabel(channel)} send blocked because the 24-hour standard messaging window has closed. Only a real staff member may reply with Meta's Human Agent path for up to 7 days after the customer's latest message.`;
  }
  return `${channelLabel(channel)} send blocked because the 24-hour standard messaging window has closed. The customer must message again before a normal reply can be sent.`;
}

function outsideHumanAgentWindowError(channel) {
  return `${channelLabel(channel)} send blocked because Meta's 7-day Human Agent window has closed. The customer must message again before staff can reply.`;
}

function evaluateFreeformState(
  state,
  now = new Date(),
  {
    purpose = "service",
    humanAgentEnabled = null,
  } = {}
) {
  if (!state) {
    return policyError(
      "contact_not_found",
      "WhatsApp send blocked because the contact no longer exists."
    );
  }

  const channel = state.channel || "whatsapp";
  const effectiveHumanAgentEnabled =
    humanAgentEnabled === null
      ? humanAgentChannelEnabled(channel)
      : humanAgentEnabled;
  if (!STANDARD_WINDOW_CHANNELS.has(channel)) {
    return { allowed: true, code: null, message: null };
  }

  const lastInboundAt = state.latest_inbound_at
    ? new Date(state.latest_inbound_at)
    : null;
  const optOutValue = channel === "whatsapp"
    ? state.whatsapp_opt_out_at : state.social_opt_out_at;
  const marketingOptOutValue = channel === "whatsapp"
    ? state.whatsapp_marketing_opt_out_at : state.social_marketing_opt_out_at;
  const optOutAt = optOutValue ? new Date(optOutValue) : null;
  const marketingOptOutAt = marketingOptOutValue ? new Date(marketingOptOutValue) : null;

  if (optOutAt) {
    // Opt-out is a hard stop for proactive/marketing sends. A customer is still
    // allowed to start a later support conversation themselves; in that case a
    // normal service reply may resume inside the new 24-hour window without
    // silently turning marketing consent back on.
    const customerReinitiatedAfterOptOut =
      lastInboundAt && lastInboundAt.getTime() > optOutAt.getTime();
    if (purpose !== "service" || !customerReinitiatedAfterOptOut) {
      return policyError(
        "opted_out",
        `${channelLabel(channel)} send blocked because this customer opted out of messages. Record a new explicit opt-in before sending proactive or marketing messages again.`
      );
    }
  }

  if (purpose === "marketing" && marketingOptOutAt) {
    return policyError(
      "marketing_opted_out",
      `${channelLabel(channel)} marketing send blocked because this customer opted out of promotional messages. Record a new explicit opt-in that covers marketing before sending promotional messages again.`,
      { marketingOptOutAt }
    );
  }

  if (!lastInboundAt) {
    return policyError(
      "no_customer_message",
      noCustomerMessageError(channel)
    );
  }

  const current = now instanceof Date ? now : new Date(now);
  const windowEndsAt = new Date(lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  const humanAgentWindowEndsAt =
    effectiveHumanAgentEnabled && HUMAN_AGENT_CHANNELS.has(channel)
      ? new Date(lastInboundAt.getTime() + HUMAN_AGENT_WINDOW_MS)
      : null;

  if (current.getTime() >= windowEndsAt.getTime()) {
    const humanAgentRequested =
      effectiveHumanAgentEnabled &&
      purpose === "human_agent" &&
      HUMAN_AGENT_CHANNELS.has(channel);

    if (
      humanAgentRequested &&
      humanAgentWindowEndsAt &&
      current.getTime() < humanAgentWindowEndsAt.getTime()
    ) {
      return {
        allowed: true,
        code: null,
        message: null,
        lastInboundAt,
        windowEndsAt,
        humanAgentWindowEndsAt,
        humanAgentRequired: true,
      };
    }

    if (
      humanAgentRequested &&
      humanAgentWindowEndsAt &&
      current.getTime() >= humanAgentWindowEndsAt.getTime()
    ) {
      return policyError(
        "outside_human_agent_window",
        outsideHumanAgentWindowError(channel),
        { lastInboundAt, windowEndsAt, humanAgentWindowEndsAt }
      );
    }

    return policyError(
      "outside_customer_service_window",
      outsideWindowError(channel, effectiveHumanAgentEnabled),
      { lastInboundAt, windowEndsAt, humanAgentWindowEndsAt }
    );
  }

  return {
    allowed: true,
    code: null,
    message: null,
    lastInboundAt,
    windowEndsAt,
    humanAgentWindowEndsAt,
    humanAgentRequired: false,
  };
}

async function checkFreeformAllowed(
  contact,
  now = new Date(),
  {
    purpose = "service",
    humanAgentEnabled = null,
  } = {}
) {
  const channel = contact?.channel || "whatsapp";
  const effectiveHumanAgentEnabled =
    humanAgentEnabled === null
      ? humanAgentChannelEnabled(channel)
      : humanAgentEnabled;
  if (!STANDARD_WINDOW_CHANNELS.has(channel)) {
    return { allowed: true, code: null, message: null };
  }

  const contactId = Number(contact?.id);
  if (!Number.isSafeInteger(contactId) || contactId <= 0) {
    return policyError(
      "missing_contact_id",
      `${channelLabel(channel)} send blocked because the contact could not be verified against messaging-policy state.`
    );
  }

  const state = await getPolicyState(contactId);
  if (!state) {
    return policyError(
      "contact_not_found",
      `${channelLabel(channel)} send blocked because the contact no longer exists.`
    );
  }
  return evaluateFreeformState(state, now, {
    purpose,
    humanAgentEnabled: effectiveHumanAgentEnabled,
  });
}

async function recordOptOut(contactId, source = "customer_message", messageAt = null) {
  const result = await pool.query(
    `WITH changed AS (
       UPDATE contacts
     SET whatsapp_opt_out_at = CASE WHEN channel = 'whatsapp' THEN COALESCE($3::timestamptz, now()) ELSE whatsapp_opt_out_at END,
         whatsapp_opt_out_source = CASE WHEN channel = 'whatsapp' THEN $2 ELSE whatsapp_opt_out_source END,
         whatsapp_marketing_opt_out_at = CASE WHEN channel = 'whatsapp' THEN COALESCE($3::timestamptz, now()) ELSE whatsapp_marketing_opt_out_at END,
         whatsapp_marketing_opt_out_source = CASE WHEN channel = 'whatsapp' THEN $2 ELSE whatsapp_marketing_opt_out_source END,
         whatsapp_opt_in_at = CASE WHEN channel = 'whatsapp' THEN NULL ELSE whatsapp_opt_in_at END,
         whatsapp_opt_in_source = CASE WHEN channel = 'whatsapp' THEN NULL ELSE whatsapp_opt_in_source END,
         social_opt_out_at = CASE WHEN channel IN ('facebook','instagram') THEN now() ELSE social_opt_out_at END,
         social_opt_out_source = CASE WHEN channel IN ('facebook','instagram') THEN $2 ELSE social_opt_out_source END,
         social_marketing_opt_out_at = CASE WHEN channel IN ('facebook','instagram') THEN now() ELSE social_marketing_opt_out_at END,
         social_marketing_opt_out_source = CASE WHEN channel IN ('facebook','instagram') THEN $2 ELSE social_marketing_opt_out_source END,
         updated_at = now()
     WHERE id = $1 AND channel IN ('whatsapp','facebook','instagram')
       AND ($3::timestamptz IS NULL OR channel <> 'whatsapp'
            OR whatsapp_opt_in_at IS NULL OR whatsapp_opt_in_at <= $3::timestamptz)
     RETURNING *
     ), synced_leads AS (
       UPDATE leads SET marketing_consent='opted_out', updated_at=now()
       WHERE contact_id IN (SELECT id FROM changed WHERE channel='whatsapp')
       RETURNING id
     )
     SELECT * FROM changed`,
    [contactId, source, messageAt]
  );
  return result.rows[0] || null;
}

async function recordMarketingOptOut(contactId, source = "customer_message", messageAt = null) {
  const result = await pool.query(
    `WITH changed AS (
       UPDATE contacts
     SET whatsapp_marketing_opt_out_at = CASE WHEN channel = 'whatsapp' THEN COALESCE($3::timestamptz, now()) ELSE whatsapp_marketing_opt_out_at END,
         whatsapp_marketing_opt_out_source = CASE WHEN channel = 'whatsapp' THEN $2 ELSE whatsapp_marketing_opt_out_source END,
         social_marketing_opt_out_at = CASE WHEN channel IN ('facebook','instagram') THEN now() ELSE social_marketing_opt_out_at END,
         social_marketing_opt_out_source = CASE WHEN channel IN ('facebook','instagram') THEN $2 ELSE social_marketing_opt_out_source END,
         updated_at = now()
     WHERE id = $1 AND channel IN ('whatsapp','facebook','instagram')
       AND ($3::timestamptz IS NULL OR channel <> 'whatsapp'
            OR whatsapp_opt_in_at IS NULL OR whatsapp_opt_in_at <= $3::timestamptz)
     RETURNING *
     ), synced_leads AS (
       UPDATE leads SET marketing_consent='opted_out', updated_at=now()
       WHERE contact_id IN (SELECT id FROM changed WHERE channel='whatsapp')
       RETURNING id
     )
     SELECT * FROM changed`,
    [contactId, source, messageAt]
  );
  return result.rows[0] || null;
}

async function recordMarketingOptIn(contactId) {
  const result = await pool.query(
    `UPDATE contacts
     SET whatsapp_marketing_opt_out_at = CASE WHEN channel = 'whatsapp' THEN NULL ELSE whatsapp_marketing_opt_out_at END,
         whatsapp_marketing_opt_out_source = CASE WHEN channel = 'whatsapp' THEN NULL ELSE whatsapp_marketing_opt_out_source END,
         social_marketing_opt_out_at = CASE WHEN channel IN ('facebook','instagram') THEN NULL ELSE social_marketing_opt_out_at END,
         social_marketing_opt_out_source = CASE WHEN channel IN ('facebook','instagram') THEN NULL ELSE social_marketing_opt_out_source END,
         updated_at = now()
     WHERE id = $1 AND channel IN ('whatsapp','facebook','instagram')
     RETURNING *`,
    [contactId]
  );
  return result.rows[0] || null;
}

async function recordOptIn(contactId, source) {
  const cleanSource = String(source || "").trim();
  if (!cleanSource) {
    throw new Error("An explicit WhatsApp opt-in source is required.");
  }

  const result = await pool.query(
    `UPDATE contacts
     SET whatsapp_opt_in_at = now(),
         whatsapp_opt_in_source = $2,
         whatsapp_opt_out_at = NULL,
         whatsapp_opt_out_source = NULL,
         updated_at = now()
     WHERE id = $1
       AND channel = 'whatsapp'
     RETURNING *`,
    [contactId, cleanSource]
  );
  return result.rows[0] || null;
}

async function checkTemplateAllowed(contact, { category = null, treatmentInterest = null } = {}) {
  if ((contact?.channel || "whatsapp") !== "whatsapp") {
    return policyError(
      "wrong_channel",
      "WhatsApp templates can only be sent to WhatsApp contacts."
    );
  }

  const contactId = Number(contact?.id);
  if (!Number.isSafeInteger(contactId) || contactId <= 0) {
    return policyError(
      "missing_contact_id",
      "WhatsApp template blocked because the contact could not be verified against messaging-policy state."
    );
  }

  const state = await getPolicyState(contactId);
  if (!state) {
    return policyError("contact_not_found", "WhatsApp template blocked because the contact no longer exists.");
  }
  if (state.whatsapp_opt_out_at) {
    return policyError(
      "opted_out",
      "WhatsApp template blocked because this customer opted out.",
      { state }
    );
  }
  if (!state.whatsapp_opt_in_at || !state.whatsapp_opt_in_source) {
    return policyError(
      "missing_opt_in",
      "WhatsApp template blocked because no explicit WhatsApp opt-in is recorded for this customer.",
      { state }
    );
  }
  if (
    String(category || "").trim().toUpperCase() === "MARKETING" &&
    state.whatsapp_marketing_opt_out_at
  ) {
    return policyError(
      "marketing_opted_out",
      "WhatsApp marketing template blocked because this customer opted out of promotional messages. Record a new explicit opt-in that covers marketing before sending promotional messages again.",
      { state }
    );
  }

  if (String(category || "").trim().toUpperCase() === "MARKETING") {
    // A general WhatsApp service opt-in does not permit promotional templates.
    // Require the current CRM lead AND a durable consent audit event.
    const intendedService = typeof treatmentInterest === "string" &&
      treatmentInterest.trim() ? treatmentInterest.trim() : null;
    const consent = await pool.query(
      `SELECT l.marketing_consent,
         EXISTS (
           SELECT 1 FROM whatsapp_marketing_consent_events e
           WHERE e.contact_id=$1
             AND e.created_at >= COALESCE($2::timestamptz, '-infinity'::timestamptz)
             AND (
               (
                 -- Actual customer-message permission is treatment-scoped.
                 -- The SAME-LEAD case must also match the treatment, not just
                 -- the inherited-lead case. Missing service is not carte blanche.
                 e.message_id IS NOT NULL
                 AND e.consent_category='MARKETING'
                 AND e.consent_scope='treatment_followups_and_related_offers'
                 AND e.consented_at=$2::timestamptz
                 AND NULLIF(BTRIM(e.consent_service),'') IS NOT NULL
                 AND NULLIF(BTRIM(l.treatment_interest),'') IS NOT NULL
                 AND LOWER(BTRIM(e.consent_service))=LOWER(BTRIM(l.treatment_interest))
                 AND ($3::text IS NULL OR
                   LOWER(BTRIM(e.consent_service))=LOWER(BTRIM($3::text)))
               )
               OR (
                 -- Staff-verified marketing permission is explicitly recorded
                 -- for the current lead. It is not silently inherited.
                 e.message_id IS NULL
                 AND e.lead_id=l.id
                 AND NULLIF(BTRIM(e.source),'') IS NOT NULL
                 AND e.consent_scope IS NULL
               )
             )
         ) AS has_evidence
       FROM leads l
       WHERE l.contact_id=$1
       ORDER BY l.is_closed ASC,l.created_at DESC,l.id DESC LIMIT 1`,
      [contactId, state.whatsapp_opt_in_at, intendedService]
    );
    const current = consent.rows[0];
    if (current?.marketing_consent !== "opted_in" || current.has_evidence !== true) {
      return policyError(
        "marketing_consent_unverified",
        "WhatsApp promotional templates require a verified Marketing consent event for the current lead. Record the customer's explicit permission and its source first.",
        { state }
      );
    }
  }

  return { allowed: true, code: null, message: null, state };
}

function blockedSendResult(policy) {
  return {
    success: false,
    wamid: null,
    externalMessageId: null,
    policyBlocked: true,
    policyCode: policy?.code || "policy_blocked",
    error: policy?.message || "Message blocked by channel messaging policy.",
  };
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  HUMAN_AGENT_WINDOW_MS,
  STANDARD_WINDOW_CHANNELS,
  blockedSendResult,
  checkFreeformAllowed,
  checkTemplateAllowed,
  classifyOptOutText,
  evaluateFreeformState,
  getPolicyState,
  isOptOutText,
  manualStaffPurpose,
  recordMarketingOptIn,
  recordMarketingOptOut,
  recordOptIn,
  recordOptOut,
};
