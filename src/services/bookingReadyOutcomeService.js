const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");

const BOOKING_READY_REASON =
  "Booking ready: customer provided scheduling preferences; staff should confirm availability.";

function safeMessageId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function createBookingReadyOutcomeService({
  database = pool,
  publish = realtimeEvents.publish,
  sendBookingReadyAlert = telegramImmediateAlerts.sendBookingReadyAlert,
} = {}) {
  return async function markBookingReadyForContact(
    contactId,
    messageId,
    reason = BOOKING_READY_REASON
  ) {
    const capturedMessageId = safeMessageId(messageId);
    const client = await database.connect();
    let contactUpdated = false;
    let leadId = null;
    let leadChanged = false;

    try {
      await client.query("BEGIN");

      // This is an AI-owned conversation outcome. If staff took over while the
      // model was generating, fail closed and leave all lead/attention state to
      // the staff-owned flow instead of applying a late automatic outcome.
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
             OR attention_reason LIKE 'Booking ready:%'
             OR attention_reason LIKE 'Delivery failed:%'
             OR attention_reason LIKE 'Delivery unconfirmed:%'
           )
         RETURNING id`,
        [reason, contactId]
      );
      contactUpdated = Boolean(contactResult.rows[0]);

      if (contactUpdated) {
        const leadResult = await client.query(
          `SELECT id, temperature, temperature_locked
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

          if (!lead.temperature_locked && lead.temperature !== "hot") {
            const updated = await client.query(
              `UPDATE leads
               SET temperature = 'hot',
                   temperature_source = 'ai',
                   updated_at = now()
               WHERE id = $1 AND is_closed = false AND temperature_locked = false
               RETURNING id`,
              [lead.id]
            );
            leadChanged = Boolean(updated.rows[0]);
          }

          const metadata = {
            source: "ai_conversation_outcome",
            outcome: "booking_ready",
            ...(capturedMessageId ? { messageId: capturedMessageId } : {}),
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
    };
  };
}

const markBookingReadyForContact = createBookingReadyOutcomeService();

module.exports = {
  BOOKING_READY_REASON,
  createBookingReadyOutcomeService,
  markBookingReadyForContact,
};
