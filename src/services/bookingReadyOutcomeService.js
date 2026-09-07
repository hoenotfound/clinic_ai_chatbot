const { pool } = require("../db/db");
const clinicConfig = require("../config/clinicConfig");
const { getConversionProfile } = require("../config/conversionProfiles");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");

const BOOKING_READY_REASON =
  "Booking ready: customer provided scheduling preferences; staff should confirm availability.";
const VALID_PROJECT_NEXT_STEPS = new Set(["site_visit", "quotation_discussion"]);

function safeMessageId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeText(value, max = 240) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function safeNextStep(value) {
  const cleaned = safeText(value);
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase().replace(/[\s-]+/g, "_");
  return VALID_PROJECT_NEXT_STEPS.has(normalized) ? normalized : null;
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
  const conversion = getConversionProfile(clinicConfig);
  const normalized = {
    branch: canonicalConfiguredValue(details.branch, clinicConfig.branches),
    treatment: canonicalConfiguredValue(details.treatment, clinicConfig.services),
    appointmentPreference: safeText(details.appointmentPreference),
  };

  // Project metadata belongs only to project-mode conversion contracts. Keep a
  // second defensive boundary here so clinic outcomes stay clean even if a
  // future caller bypasses the AI response parser and passes stray project data.
  if (conversion.mode === "project") {
    const projectLocation = safeText(details.projectLocation);
    const projectSummary = safeText(details.projectSummary);
    const nextStep = safeNextStep(details.nextStep);
    if (projectLocation) normalized.projectLocation = projectLocation;
    if (projectSummary) normalized.projectSummary = projectSummary;
    if (nextStep) normalized.nextStep = nextStep;
  }

  return normalized;
}

function currentConversionCopy() {
  const conversion = getConversionProfile(clinicConfig);
  return {
    reason: safeText(conversion.attentionReason, 500) || BOOKING_READY_REASON,
    activityDescription: safeText(conversion.activityDescription, 1000) ||
      "AI marked this conversation ready for staff follow-up.",
  };
}

function normalizeOptions(reasonOrOptions) {
  const defaults = currentConversionCopy();
  if (typeof reasonOrOptions === "string") {
    return { reason: reasonOrOptions, activityDescription: defaults.activityDescription, details: normalizeBookingDetails() };
  }
  const options = reasonOrOptions && typeof reasonOrOptions === "object"
    ? reasonOrOptions
    : {};
  return {
    reason: safeText(options.reason, 500) || defaults.reason,
    activityDescription: safeText(options.activityDescription, 1000) || defaults.activityDescription,
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
    reasonOrOptions = null
  ) {
    const capturedMessageId = safeMessageId(messageId);
    const { reason, activityDescription, details } = normalizeOptions(reasonOrOptions);
    const client = await database.connect();
    let contactUpdated = false;
    let leadId = null;
    let leadChanged = false;

    try {
      await client.query("BEGIN");

      // Normally an unresolved conversion-ready attention flag suppresses
      // another model outcome so an "ok"/"thanks" cannot spam staff. The
      // exception is genuinely changed structured conversion detail on the
      // same open lead. That change must refresh activity/Telegram instead of
      // leaving staff with stale booking or renovation project information.
      const contactResult = await client.query(
        `UPDATE contacts c
         SET needs_attention = true,
             attention_reason = $1,
             updated_at = now()
         WHERE c.id = $2
           AND c.mode = 'ai'
           AND (
             c.needs_attention = false
             OR c.attention_reason IS NULL
             OR c.attention_reason LIKE 'Delivery failed:%'
             OR c.attention_reason LIKE 'Delivery unconfirmed:%'
             OR (
               c.needs_attention = true
               AND c.attention_reason = $1
               AND EXISTS (
                 SELECT 1
                 FROM LATERAL (
                   SELECT l.id
                   FROM leads l
                   WHERE l.contact_id = c.id
                     AND l.is_closed = false
                   ORDER BY l.created_at DESC, l.id DESC
                   LIMIT 1
                 ) current_lead
                 LEFT JOIN LATERAL (
                   SELECT a.metadata
                   FROM lead_activities a
                   WHERE a.lead_id = current_lead.id
                     AND a.metadata->>'outcome' = 'booking_ready'
                   ORDER BY a.created_at DESC, a.id DESC
                   LIMIT 1
                 ) latest_booking ON true
                 WHERE
                   ($3::text IS NOT NULL AND latest_booking.metadata->>'branch' IS DISTINCT FROM $3::text)
                   OR ($4::text IS NOT NULL AND latest_booking.metadata->>'treatment' IS DISTINCT FROM $4::text)
                   OR ($5::text IS NOT NULL AND latest_booking.metadata->>'appointmentPreference' IS DISTINCT FROM $5::text)
                   OR ($6::text IS NOT NULL AND latest_booking.metadata->>'projectLocation' IS DISTINCT FROM $6::text)
                   OR ($7::text IS NOT NULL AND latest_booking.metadata->>'projectSummary' IS DISTINCT FROM $7::text)
                   OR ($8::text IS NOT NULL AND latest_booking.metadata->>'nextStep' IS DISTINCT FROM $8::text)
               )
             )
           )
         RETURNING id`,
        [
          reason,
          contactId,
          details.branch,
          details.treatment,
          details.appointmentPreference,
          details.projectLocation || null,
          details.projectSummary || null,
          details.nextStep || null,
        ]
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
            // Keep the historical outcome value for compatibility with stored
            // activity data and existing consumers while the domain layer is
            // generalized above it.
            outcome: "booking_ready",
            ...(capturedMessageId ? { messageId: capturedMessageId } : {}),
            ...(details.branch ? { branch: details.branch } : {}),
            ...(details.treatment ? { treatment: details.treatment } : {}),
            ...(details.appointmentPreference
              ? { appointmentPreference: details.appointmentPreference }
              : {}),
            ...(details.projectLocation ? { projectLocation: details.projectLocation } : {}),
            ...(details.projectSummary ? { projectSummary: details.projectSummary } : {}),
            ...(details.nextStep ? { nextStep: details.nextStep } : {}),
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
              activityDescription,
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
          details,
        })
      ).catch((err) => {
        console.error(`Telegram conversion-ready alert failed for contact ${contactId}:`, err);
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
