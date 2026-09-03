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
      `UPDATE contacts
       SET takeover_by = $1,
           takeover_at = now(),
           updated_at = now()
       WHERE id = $2
         AND mode = 'human'
         AND takeover_by = $3
       RETURNING *`,
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
