const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");

const AI_HANDOFF_OWNER = "AI handoff";

/**
 * Converts an AI-owned conversation into Staff mode without using the normal
 * staff takeover helper (which intentionally clears Needs Attention).
 *
 * The update is conditional on mode='ai', so if a staff member takes over
 * while the model is generating this becomes a no-op and the late AI reply is
 * suppressed by the caller.
 */
async function pauseAiForHumanHandoff(
  contactId,
  reason = "AI handed off this conversation."
) {
  const result = await pool.query(
    `UPDATE contacts c
     SET mode = 'human',
         takeover_by = $1,
         takeover_at = now(),
         needs_attention = true,
         attention_reason = $2,
         updated_at = now()
     WHERE c.id = $3
       AND c.mode = 'ai'
     RETURNING c.*,
       (SELECT m.id FROM messages m
        WHERE m.contact_id = c.id AND m.role = 'user'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS attention_message_id`,
    [AI_HANDOFF_OWNER, reason, contactId]
  );

  const updated = result.rows[0] || null;
  if (!updated) return null;

  realtimeEvents.publish("conversation_changed", {
    contactId: updated.id,
    reason: "ai_handoff",
  });

  Promise.resolve(
    telegramImmediateAlerts.sendHumanInterventionAlert({
      contactId: updated.id,
      messageId: updated.attention_message_id,
      reason: updated.attention_reason || reason,
    })
  ).catch((err) => {
    console.error(`Telegram AI-handoff alert failed for contact ${updated.id}:`, err);
  });

  return updated;
}

module.exports = {
  AI_HANDOFF_OWNER,
  pauseAiForHumanHandoff,
};