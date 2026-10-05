// All database work that changes a conversation snapshot uses the same
// transaction-scoped advisory lock. The namespace keeps these locks separate
// from the message-retry locks, which use a single bigint message id.
const CONVERSATION_LOCK_NAMESPACE = 24681;

// WhatsApp reaction webhooks can arrive concurrently with the send/echo path
// that first makes a provider WAMID visible locally. Serialize both sides on a
// stable advisory-lock namespace derived from the WAMID so neither side can
// commit between the other's "target missing" check and pending-reaction write.
const WHATSAPP_MESSAGE_LOCK_NAMESPACE = 24682;

async function lockWhatsappMessageId(client, whatsappMessageId) {
  const wamid = String(whatsappMessageId || "").trim();
  if (!wamid) {
    throw new Error("A valid WhatsApp message id is required to lock a WAMID.");
  }

  await client.query(
    "SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))",
    [WHATSAPP_MESSAGE_LOCK_NAMESPACE, wamid]
  );
}


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
  WHATSAPP_MESSAGE_LOCK_NAMESPACE,
  lockConversation,
  lockWhatsappMessageId,
};
