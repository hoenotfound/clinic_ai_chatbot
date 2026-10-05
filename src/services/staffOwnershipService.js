const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");
const { AI_HANDOFF_OWNER } = require("./aiHandoffService");

function createStaffOwnershipService({
  database = pool,
  publish = realtimeEvents.publish,
} = {}) {
  return async function claimAiHandoffOwnership(contactId, username) {
    const staffUsername = String(username || "").trim();
    if (!staffUsername) return null;

    const result = await database.query(
      `WITH takeover AS (
         UPDATE contacts
         SET takeover_by = $1,
             takeover_at = now(),
             updated_at = now()
         WHERE id = $2
           AND mode = 'human'
           AND takeover_by = $3
         RETURNING *
       ), latest_inbound AS (
         SELECT inbound.id, inbound.created_at
         FROM messages inbound, takeover
         WHERE inbound.contact_id = takeover.id
           AND inbound.role = 'user'
         ORDER BY inbound.created_at DESC, inbound.id DESC
         LIMIT 1
       ), anchor AS (
         SELECT outbound.id, outbound.sent_by_username
         FROM messages outbound, takeover, latest_inbound
         WHERE outbound.contact_id = takeover.id
           AND outbound.role = 'assistant'
           AND outbound.is_automated_follow_up = false
           AND (outbound.created_at, outbound.id) >
               (latest_inbound.created_at, latest_inbound.id)
         ORDER BY outbound.created_at DESC, outbound.id DESC
         LIMIT 1
       ), cancelled_sequence AS (
         INSERT INTO follow_up_ai_decisions (
           contact_id,
           trigger_message_id,
           follow_up_step,
           action,
           reason,
           topic
         )
         SELECT
           takeover.id,
           anchor.id,
           1,
           'skip',
           'Cancelled because clinic staff claimed this AI handoff.',
           NULL
         FROM takeover, anchor
         WHERE anchor.sent_by_username IS NULL
         ON CONFLICT (trigger_message_id, follow_up_step) DO NOTHING
         RETURNING id
       )
       SELECT takeover.*
       FROM takeover
       LEFT JOIN cancelled_sequence ON true`,
      [staffUsername, contactId, AI_HANDOFF_OWNER]
    );

    const updated = result.rows[0] || null;
    if (updated) {
      publish("conversation_changed", {
        contactId: updated.id,
        reason: "staff_claimed_ai_handoff",
      });
    }
    return updated;
  };
}

const claimAiHandoffOwnership = createStaffOwnershipService();

module.exports = {
  createStaffOwnershipService,
  claimAiHandoffOwnership,
};
