const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");

const AGREED_TIME_REASON =
  "Booking ready: customer accepted a staff-offered time; clinic should finalize the appointment.";

function isBriefAcceptance(value) {
  const text = String(value || "").trim().replace(/[.!！。～~😊🙏👍\s]+$/gu, "").trim();
  if (!text || text.length > 45) return false;
  return /^(?:ok(?:ay)?|yes|sure|can|confirmed?|alright|fine|好的?|可以(?:的)?|没问题|沒問題|行|嗯|好呀|可以呀|是的|boleh|baik|ya|setuju)$/iu.test(text);
}

function hasSpecificStaffTimeOffer(value) {
  const text = String(value || "");
  const date = /(?:\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|星期[一二三四五六日天]|周[一二三四五六日天]|週[一二三四五六日天]|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b)/iu;
  const time = /(?:\b(?:[01]?\d|2[0-3])[:：.][0-5]\d\s*(?:a\.?m\.?|p\.?m\.?)?\b|\b(?:1[0-2]|0?[1-9])\s*(?:a\.?m\.?|p\.?m\.?)\b|(?:[一二三四五六七八九十]|\d{1,2})\s*[点點](?:半|[0-5]?\d\s*分)?)/iu;
  const isSchedulingOffer = /(?:方便吗|方便嗎|可以吗|可以嗎|预约|預約|安排|时间你|時間你|works?\??|availab|time\s*slot|appointment|booking|temujanji|boleh\s*(?:tak|ke)|sesuai\s*(?:tak|ke))/iu;
  return date.test(text) && time.test(text) && isSchedulingOffer.test(text);
}

function isExplicitRescheduleOffer(value) {
  return /(?:改(?:到|成|去|为|為|时间|時間)|换(?:去|到|成|时间|時間)|調整|调整|改期|改约|改約|reschedul|change\s+(?:the\s+)?(?:date|time|slot)|another\s+(?:date|time|slot)|tukar\s+(?:masa|tarikh)|ubah\s+(?:masa|tarikh))/iu.test(String(value || ""));
}

function createStaffAppointmentAcceptanceService({ database = pool, publish = realtimeEvents.publish } = {}) {
  return async function recordStaffAppointmentAcceptance(contactId, inboundMessageId, customerText) {
    if (!Number.isSafeInteger(Number(contactId)) || !Number.isSafeInteger(Number(inboundMessageId))) return null;
    if (!isBriefAcceptance(customerText)) return null;
    const client = await database.connect();
    let outcome = null;
    try {
      await client.query("BEGIN");
      // Serialize acceptance decisions for the same contact across retries.
      await client.query("SELECT id FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
      const selected = await client.query(
        [
          "SELECT staff.id AS staff_message_id, staff.content AS staff_text,",
          "       lead.id AS lead_id, lead.appointment_status, lead.stage_id AS old_stage_id",
          "FROM messages inbound",
          "JOIN LATERAL (",
          "  SELECT m.id, m.content, m.sent_by_username",
          "  FROM messages m",
          "  WHERE m.contact_id = inbound.contact_id AND m.id < inbound.id",
          "    AND m.role = 'assistant' AND m.is_automated_follow_up = false",
          "    AND m.created_at >= inbound.created_at - interval '14 days'",
          "    AND COALESCE(m.delivery_status, 'pending') IN ('pending','sent','delivered','read')",
          "    AND m.whatsapp_message_id IS NOT NULL",
          "  ORDER BY m.id DESC LIMIT 1",
          ") staff ON true",
          "JOIN LATERAL (",
          "  SELECT l.id, l.appointment_status, l.stage_id FROM leads l",
          "  WHERE l.contact_id = inbound.contact_id AND l.is_closed = false",
          "  ORDER BY l.created_at DESC, l.id DESC LIMIT 1",
          ") lead ON true",
          "WHERE inbound.id = $2 AND inbound.contact_id = $1 AND inbound.role = 'user'",
          "  AND staff.sent_by_username IS NOT NULL LIMIT 1",
        ].join("\n"),
        [contactId, inboundMessageId]
      );
      const offer = selected.rows[0];
      if (!offer || !hasSpecificStaffTimeOffer(offer.staff_text)) {
        await client.query("COMMIT");
        return null;
      }
      const metadata = {
        outcome: "staff_time_accepted",
        source: "authenticated_staff_offer",
        inboundMessageId: Number(inboundMessageId),
        staffMessageId: Number(offer.staff_message_id),
        agreedTimeText: String(offer.staff_text).trim().slice(0, 400),
      };
      const inserted = await client.query(
        [
          "INSERT INTO lead_activities (lead_id, activity_type, description, actor, metadata)",
          "SELECT $1, 'updated', 'Customer accepted a staff-offered time; availability needs confirmation.', 'Automation', $2::jsonb",
          "WHERE NOT EXISTS (",
          "  SELECT 1 FROM lead_activities a",
          "  WHERE a.lead_id = $1 AND a.metadata->>'outcome' = 'staff_time_accepted'",
          "    AND a.metadata->>'inboundMessageId' = $3::text",
          ") RETURNING id",
        ].join("\n"),
        [offer.lead_id, JSON.stringify(metadata), inboundMessageId]
      );
      if (inserted.rows.length) {
        // A changed staff proposal supersedes an old booked slot, but does
        // not confirm the replacement booking or cause a template send.
        const reschedule = offer.appointment_status === "set" &&
          isExplicitRescheduleOffer(offer.staff_text);
        if (reschedule) {
          const rescheduled = await client.query(
            [
              "UPDATE leads SET appointment_status = 'reschedule', appointment_at = NULL,",
              "  stage_id = COALESCE((",
              "    SELECT id FROM pipeline_stages",
              "    WHERE system_key = 'contacted' AND stage_type = 'open' LIMIT 1",
              "  ), stage_id), updated_at = now()",
              "WHERE id = $1 AND appointment_status = 'set' RETURNING stage_id",
            ].join("\n"),
            [offer.lead_id]
          );
          if (rescheduled.rows[0] && Number(rescheduled.rows[0].stage_id) !== Number(offer.old_stage_id)) {
            await client.query(
              "INSERT INTO lead_stage_history (lead_id, from_stage_id, to_stage_id, changed_by) VALUES ($1, $2, $3, $4)",
              [offer.lead_id, offer.old_stage_id, rescheduled.rows[0].stage_id, "Automation"]
            );
          }
          await client.query(
            "INSERT INTO lead_activities (lead_id, activity_type, description, actor, metadata) VALUES ($1, 'updated', $2, 'Automation', $3::jsonb)",
            [offer.lead_id, "Staff-offered reschedule accepted; replacement slot requires confirmation.",
              JSON.stringify({ ...metadata, outcome: "reschedule_pending" })]
          );
        }
        if (offer.appointment_status !== "set" || reschedule) {
          await client.query(
            [
              "UPDATE contacts SET needs_attention = true, attention_reason = $2, updated_at = now()",
              "WHERE id = $1 AND mode = 'ai'",
              "  AND (needs_attention = false OR attention_reason LIKE 'Booking ready:%')",
              "  AND NOT EXISTS (SELECT 1 FROM ai_review_items r WHERE r.contact_id = contacts.id",
              "    AND r.status = 'pending' AND r.category <> 'information')",
            ].join("\n"),
            [contactId, AGREED_TIME_REASON]
          );
        }
        outcome = { leadId: offer.lead_id, agreedTimeText: metadata.agreedTimeText };
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (outcome) {
      publish("pipeline_changed", { leadId: outcome.leadId });
      publish("conversation_changed", { contactId, reason: "staff_time_accepted" });
    }
    return outcome;
  };
}
const recordStaffAppointmentAcceptance = createStaffAppointmentAcceptanceService();
module.exports = {
  AGREED_TIME_REASON, isBriefAcceptance, hasSpecificStaffTimeOffer,
  isExplicitRescheduleOffer, createStaffAppointmentAcceptanceService,
  recordStaffAppointmentAcceptance,
};
