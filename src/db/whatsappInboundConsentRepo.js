"use strict";

const { pool } = require("./db");
const { explicitPromotionConsent } = require("../utils/explicitWhatsAppConsent");

/**
 * Records the actual customer message, not the suggested message displayed
 * inside Ads Manager. Only a new, affirmative, business-named WhatsApp
 * promotional opt-in can change CRM/contact consent state.
 *
 * A single transaction makes the evidence, lead consent and WhatsApp consent
 * all-or-nothing. The inbound message ID is unique so job recovery cannot
 * refresh an opt-in timestamp or re-enable a past opt-out.
 */
async function recordFromInbound({
  contactId, messageId, leadId, businessName, isClickToWhatsApp = false,
}, { database = pool } = {}) {
  if (![contactId, messageId, leadId].every((value) =>
    Number.isSafeInteger(Number(value)) && Number(value) > 0) ||
    !String(businessName || "").trim()) return { recorded: false, reason: "invalid_input" };

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const contact = (await client.query(
      `SELECT id, channel, whatsapp_opt_in_at, whatsapp_opt_out_at,
              whatsapp_marketing_opt_out_at
         FROM contacts WHERE id=$1 FOR UPDATE`, [contactId]
    )).rows[0];
    if (!contact || contact.channel !== "whatsapp") {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "wrong_channel" };
    }
    const message = (await client.query(
      `SELECT id, role, content, whatsapp_message_id,
              COALESCE(source_created_at, created_at) AS sent_at,
              media_mime_type, is_forwarded
         FROM messages WHERE id=$1 AND contact_id=$2`,
      [messageId, contactId]
    )).rows[0];
    const explicit = message?.role === "user" &&
      Boolean(String(message.whatsapp_message_id || "").trim()) &&
      !message.media_mime_type && message.is_forwarded !== true
      ? explicitPromotionConsent(message.content, { businessName })
      : null;
    if (!explicit) {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "not_explicit" };
    }
    const lead = (await client.query(
      "SELECT id FROM leads WHERE id=$1 AND contact_id=$2 FOR UPDATE",
      [leadId, contactId]
    )).rows[0];
    if (!lead) {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "lead_missing" };
    }

    const sentAt = new Date(message.sent_at);
    if (!Number.isFinite(sentAt.getTime())) {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "invalid_timestamp" };
    }
    // Historical webhook replay cannot override an opt-out or a more recent
    // consent event. A customer may renew marketing consent explicitly AFTER
    // a previous marketing opt-out, but global STOP requires staff verification.
    const globalStop = contact.whatsapp_opt_out_at
      ? new Date(contact.whatsapp_opt_out_at).getTime() : null;
    const marketingStop = contact.whatsapp_marketing_opt_out_at
      ? new Date(contact.whatsapp_marketing_opt_out_at).getTime() : null;
    const currentOptIn = contact.whatsapp_opt_in_at
      ? new Date(contact.whatsapp_opt_in_at).getTime() : null;
    if (globalStop != null ||
        (marketingStop != null && sentAt.getTime() <= marketingStop) ||
        (currentOptIn != null && sentAt.getTime() <= currentOptIn)) {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "outdated_or_opted_out" };
    }

    const source = isClickToWhatsApp
      ? "ctwa_explicit_customer_message" : "explicit_customer_message";
    const inserted = await client.query(
      `INSERT INTO whatsapp_marketing_consent_events
       (contact_id,lead_id,source,recorded_by,message_id,
        provider_message_id,message_text,business_name,
        consent_scope,consent_category,consented_at,consent_method)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING RETURNING id`,
      [contactId,leadId,source,messageId,message.whatsapp_message_id,
        message.content,businessName,explicit.scope,explicit.category,
        sentAt.toISOString(),explicit.method]
    );
    if (inserted.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { recorded: false, reason: "already_recorded" };
    }
    await client.query(
      `UPDATE contacts
       SET whatsapp_opt_in_at=$2,
           whatsapp_opt_in_source=$3,
           whatsapp_marketing_opt_out_at=NULL,
           whatsapp_marketing_opt_out_source=NULL,
           updated_at=now()
       WHERE id=$1 AND channel='whatsapp'`,
      [contactId,sentAt.toISOString(),source]
    );
    await client.query(
      `UPDATE leads SET marketing_consent='opted_in', updated_at=now()
       WHERE id=$1 AND contact_id=$2`,
      [leadId,contactId]
    );
    await client.query("COMMIT");
    return { recorded: true, reason: "explicit_message" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { recordFromInbound };
