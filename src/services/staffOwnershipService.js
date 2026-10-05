const { pool } = require("../db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../db/conversationLock");
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
      `WITH conversation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $2::integer)
       ), eligible_contact AS MATERIALIZED (
         SELECT c.id
         FROM contacts c, conversation_lock
         WHERE c.id = $2
           AND c.mode = 'human'
           AND c.takeover_by = $3
       ), latest_inbound AS (
         SELECT inbound.id, inbound.created_at
         FROM messages inbound, eligible_contact
         WHERE inbound.contact_id = eligible_contact.id
           AND inbound.role = 'user'
         ORDER BY inbound.created_at DESC, inbound.id DESC
         LIMIT 1
       ), anchor AS (
         SELECT outbound.id, outbound.sent_by_username
         FROM messages outbound, eligible_contact, latest_inbound
         WHERE outbound.contact_id = eligible_contact.id
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
           eligible_contact.id,
           anchor.id,
           1,
           'skip',
           'Cancelled because clinic staff claimed this AI handoff.',
           NULL
         FROM eligible_contact, anchor
         WHERE anchor.sent_by_username IS NULL
         ON CONFLICT (trigger_message_id, follow_up_step) DO NOTHING
         RETURNING id
       ), takeover AS (
         UPDATE contacts c
         SET takeover_by = $1,
             takeover_at = now(),
             updated_at = now()
         FROM eligible_contact
         WHERE c.id = eligible_contact.id
         RETURNING c.*
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
