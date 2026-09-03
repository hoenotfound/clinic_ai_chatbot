const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");

const BOOKING_READY_REASON =
  "Booking ready: customer provided scheduling preferences; staff should confirm availability.";

function safeMessageId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeText(value, max = 240) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function canonicalConfiguredValue(value, items, key = "name") {
  const cleaned = safeText(value);
  if (!cleaned) return null;
  const match = (items || []).find(
    (item) => String(item?.[key] || "").trim().toLowerCase() === cleaned.toLowerCase()
  );
  return match ? String(match[key]).trim() : null;
}

function normalizeBookingDetails(details = {}) {
  return {
    branch: canonicalConfiguredValue(details.branch, clinicConfig.branches),
    treatment: canonicalConfiguredValue(details.treatment, clinicConfig.services),
    appointmentPreference: safeText(details.appointmentPreference),
  };
}

function normalizeOptions(reasonOrOptions) {
  if (typeof reasonOrOptions === "string") {
    return { reason: reasonOrOptions, details: normalizeBookingDetails() };
  }
  const options = reasonOrOptions && typeof reasonOrOptions === "object"
    ? reasonOrOptions
    : {};
  return {
    reason: safeText(options.reason, 500) || BOOKING_READY_REASON,
    details: normalizeBookingDetails(options.details || options),
  };
}

function createBookingReadyOutcomeService({
  database = pool,
  publish = realtimeEvents.publish,
  sendBookingReadyAlert = telegramImmediateAlerts.sendBookingReadyAlert,
} = {}) {
  return async function markBookingReadyForContact(
    contactId,
    messageId,
    reasonOrOptions = BOOKING_READY_REASON
  ) {
    const capturedMessageId = safeMessageId(messageId);
    const { reason, details } = normalizeOptions(reasonOrOptions);
    const client = await database.connect();
    let contactUpdated = false;
    let leadId = null;
    let leadChanged = false;

    try {
      await client.query("BEGIN");

      const contactResult = await client.query(
        `UPDATE contacts
         SET needs_attention = true,
             attention_reason = $1,
             updated_at = now()
         WHERE id = $2
           AND mode = 'ai'
           AND (
             needs_attention = false
             OR attention_reason IS NULL
             OR attention_reason LIKE 'Delivery failed:%'
             OR attention_reason LIKE 'Delivery unconfirmed:%'
           )
         RETURNING id`,
        [reason, contactId]
      );
      contactUpdated = Boolean(contactResult.rows[0]);

      if (contactUpdated) {
        const leadResult = await client.query(
          `SELECT id, temperature, temperature_locked, branch_name, treatment_interest
           FROM leads
           WHERE contact_id = $1 AND is_closed = false
           ORDER BY created_at DESC, id DESC
           LIMIT 1
           FOR UPDATE`,
          [contactId]
        );
        const lead = leadResult.rows[0] || null;

        if (lead) {
          leadId = lead.id;

          const shouldHeat = !lead.temperature_locked && lead.temperature !== "hot";
          const shouldUpdateBranch = details.branch && lead.branch_name !== details.branch;
          const shouldUpdateTreatment = details.treatment && lead.treatment_interest !== details.treatment;

          if (shouldHeat || shouldUpdateBranch || shouldUpdateTreatment) {
            const updated = await client.query(
              `UPDATE leads
               SET temperature = CASE
                     WHEN temperature_locked = false THEN 'hot'
                     ELSE temperature
                   END,
                   temperature_source = CASE
                     WHEN temperature_locked = false THEN 'ai'
                     ELSE temperature_source
                   END,
                   branch_name = COALESCE($2, branch_name),
                   treatment_interest = COALESCE($3, treatment_interest),
                   updated_at = now()
               WHERE id = $1 AND is_closed = false
               RETURNING id`,
              [lead.id, details.branch, details.treatment]
            );
            leadChanged = Boolean(updated.rows[0]);
          }

          const metadata = {
            source: "ai_conversation_outcome",
            outcome: "booking_ready",
            ...(capturedMessageId ? { messageId: capturedMessageId } : {}),
            ...(details.branch ? { branch: details.branch } : {}),
            ...(details.treatment ? { treatment: details.treatment } : {}),
            ...(details.appointmentPreference
              ? { appointmentPreference: details.appointmentPreference }
              : {}),
          };
          const activityResult = await client.query(
            `INSERT INTO lead_activities (
               lead_id, activity_type, description, actor, metadata
             )
             SELECT $1, 'updated', $2, 'AI outcome', $3
             WHERE NOT EXISTS (
               SELECT 1
               FROM lead_activities existing
               WHERE existing.lead_id = $1
                 AND existing.activity_type = 'updated'
                 AND existing.metadata->>'outcome' = 'booking_ready'
                 AND (
                   $4::integer IS NULL
                   OR existing.metadata->>'messageId' = $4::text
                 )
             )
             RETURNING id`,
            [
              lead.id,
              "AI marked this conversation Booking Ready. Staff should verify the requested branch/time and confirm availability before setting the appointment.",
              metadata,
              capturedMessageId,
            ]
          );
          leadChanged = leadChanged || Boolean(activityResult.rows[0]);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (contactUpdated) {
      publish("conversation_changed", {
        contactId,
        reason: "booking_ready",
      });
    }
    if (leadId && leadChanged) {
      publish("pipeline_changed", { leadId });
    }

    if (contactUpdated) {
      Promise.resolve(
        sendBookingReadyAlert({
          contactId,
          messageId: capturedMessageId,
          reason,
        })
      ).catch((err) => {
        console.error(`Telegram booking-ready alert failed for contact ${contactId}:`, err);
      });
    }

    return {
      contactUpdated,
      leadId,
      leadChanged,
      details,
    };
  };
}

const markBookingReadyForContact = createBookingReadyOutcomeService();

module.exports = {
  BOOKING_READY_REASON,
  canonicalConfiguredValue,
  createBookingReadyOutcomeService,
  markBookingReadyForContact,
  normalizeBookingDetails,
  normalizeOptions,
};
