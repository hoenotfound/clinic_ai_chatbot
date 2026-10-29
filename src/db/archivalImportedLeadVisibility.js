// Imported WhatsApp Business App history is available in Inbox, but does not
// represent a fresh sales lead. This reusable SQL predicate excludes ONLY
// untouched migration backfills with no genuine post-import customer messages.
// Once a customer sends a real inbound message (or staff assigns/moves the
// lead), their existing record becomes visible again without data mutation.
// Aliases below are fixed by application code, never supplied by callers.
function visibleSalesLeadSql(leadAlias = "l") {
  if (!["l", "lead"].includes(leadAlias)) {
    throw new Error("Unsupported archival lead SQL alias.");
  }
  return `NOT (
    COALESCE(${leadAlias}.created_by = 'Migration', FALSE)
    AND ${leadAlias}.owner_username IS NULL
    AND EXISTS (
      SELECT 1 FROM whatsapp_sender_coexistence_history_messages archive_start
      WHERE archive_start.message_id = ${leadAlias}.started_message_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM lead_stage_history staff_change
      WHERE staff_change.lead_id = ${leadAlias}.id
        AND staff_change.changed_by <> 'Migration'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages fresh_inbound
      WHERE fresh_inbound.contact_id = ${leadAlias}.contact_id
        AND fresh_inbound.role = 'user'
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_sender_coexistence_history_messages historic_inbound
          WHERE historic_inbound.message_id = fresh_inbound.id
        )
    )
  )`;
}

module.exports = { visibleSalesLeadSql };
