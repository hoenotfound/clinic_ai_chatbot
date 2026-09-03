const { pool } = require("../db/db");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const OPT_OUT_PATTERNS = [
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
];

function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/[.!！。?？]+$/g, "")
    .replace(/\s+/g, " ");
}

function isOptOutText(value) {
  const text = normalizeText(value);
  if (!text) return false;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
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
       (
         SELECT m.created_at
         FROM messages m
         WHERE m.contact_id = c.id
           AND m.role = 'user'
         ORDER BY m.created_at DESC, m.id DESC
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

async function checkFreeformAllowed(contact, now = new Date()) {
  if ((contact?.channel || "whatsapp") !== "whatsapp") {
    return { allowed: true, code: null, message: null };
  }

  const contactId = Number(contact?.id);
  if (!Number.isSafeInteger(contactId) || contactId <= 0) {
    return policyError(
      "missing_contact_id",
      "WhatsApp send blocked because the contact could not be verified against messaging-policy state."
    );
  }

  const state = await getPolicyState(contactId);
  if (!state) {
    return policyError(
      "contact_not_found",
      "WhatsApp send blocked because the contact no longer exists."
    );
  }

  if (state.whatsapp_opt_out_at) {
    return policyError(
      "opted_out",
      "WhatsApp send blocked because this customer opted out of WhatsApp messages. Record a new explicit opt-in before messaging them again."
    );
  }

  if (!state.latest_inbound_at) {
    return policyError(
      "no_customer_message",
      "WhatsApp send blocked because this customer has never messaged the business. Use an approved template only after valid WhatsApp opt-in has been recorded."
    );
  }

  const lastInboundAt = new Date(state.latest_inbound_at);
  const windowEndsAt = new Date(lastInboundAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  if (now.getTime() >= windowEndsAt.getTime()) {
    return policyError(
      "outside_customer_service_window",
      "WhatsApp send blocked because the 24-hour customer-service window has closed. Use an approved template only after valid WhatsApp opt-in has been recorded.",
      { lastInboundAt, windowEndsAt }
    );
  }

  return {
    allowed: true,
    code: null,
    message: null,
    lastInboundAt,
    windowEndsAt,
  };
}

async function recordOptOut(contactId, source = "customer_message") {
  const result = await pool.query(
    `UPDATE contacts
     SET whatsapp_opt_out_at = now(),
         whatsapp_opt_out_source = $2,
         whatsapp_opt_in_at = NULL,
         whatsapp_opt_in_source = NULL,
         updated_at = now()
     WHERE id = $1
       AND channel = 'whatsapp'
     RETURNING *`,
    [contactId, source]
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

async function checkTemplateAllowed(contact) {
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
      "WhatsApp template blocked because this customer opted out."
    );
  }
  if (!state.whatsapp_opt_in_at || !state.whatsapp_opt_in_source) {
    return policyError(
      "missing_opt_in",
      "WhatsApp template blocked because no explicit WhatsApp opt-in is recorded for this customer."
    );
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
    error: policy?.message || "WhatsApp send blocked by messaging policy.",
  };
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  blockedSendResult,
  checkFreeformAllowed,
  checkTemplateAllowed,
  getPolicyState,
  isOptOutText,
  recordOptIn,
  recordOptOut,
};
