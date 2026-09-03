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
function createAiHandoffService({
  database = pool,
  publish = realtimeEvents.publish,
  sendHumanInterventionAlert = telegramImmediateAlerts.sendHumanInterventionAlert,
} = {}) {
  return async function pauseAiForHumanHandoff(
    contactId,
    reason = "AI handed off this conversation."
  ) {
    const result = await database.query(
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

    publish("conversation_changed", {
      contactId: updated.id,
      reason: "ai_handoff",
    });

    Promise.resolve(
      sendHumanInterventionAlert({
        contactId: updated.id,
        messageId: updated.attention_message_id,
        reason: updated.attention_reason || reason,
      })
    ).catch((err) => {
      console.error(`Telegram AI-handoff alert failed for contact ${updated.id}:`, err);
    });

    return updated;
  };
}

/**
 * Re-checks that the conversation is still in the temporary synthetic handoff
 * state immediately before the one final AI handoff acknowledgement is sent.
 * If a real staff member has claimed the chat in the meantime, this returns
 * null so the late AI message is suppressed.
 */
async function getPendingAiHandoffContact(contactId, database = pool) {
  const result = await database.query(
    `SELECT *
     FROM contacts
     WHERE id = $1
       AND mode = 'human'
       AND takeover_by = $2
     LIMIT 1`,
    [contactId, AI_HANDOFF_OWNER]
  );
  return result.rows[0] || null;
}

const pauseAiForHumanHandoff = createAiHandoffService();

module.exports = {
  AI_HANDOFF_OWNER,
  createAiHandoffService,
  getPendingAiHandoffContact,
  pauseAiForHumanHandoff,
};