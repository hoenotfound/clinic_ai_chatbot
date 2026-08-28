// All database work that changes a conversation snapshot uses the same
// transaction-scoped advisory lock. The namespace keeps these locks separate
// from the message-retry locks, which use a single bigint message id.
const CONVERSATION_LOCK_NAMESPACE = 24681;

async function lockConversation(client, contactId) {
  const parsedContactId = Number(contactId);
  if (!Number.isSafeInteger(parsedContactId) || parsedContactId < 1) {
    throw new Error("A valid contact id is required to lock a conversation.");
  }

  await client.query(
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
    [CONVERSATION_LOCK_NAMESPACE, parsedContactId]
  );
}

module.exports = {
  CONVERSATION_LOCK_NAMESPACE,
  lockConversation,
};
