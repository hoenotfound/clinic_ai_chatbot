"use strict";

const { pool } = require("./db");
const { normalizeWhatsappNumber } = require("../utils/whatsappPhoneNormalization");

function digits(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9]+$/.test(text)) throw new Error(label + " must be numeric.");
  return text;
}
function customerId(value) {
  if (typeof value !== "string" || !/^[+\d\s().-]+$/.test(value)) {
    throw new Error("Invalid WhatsApp customer number.");
  }
  const normalized = normalizeWhatsappNumber(value);
  if (!/^\d{8,15}$/.test(normalized)) {
    throw new Error("Invalid WhatsApp customer number.");
  }
  return normalized;
}
function positiveId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("A positive integer ID is required.");
  }
  return number;
}

// Pending is not an Inbox contact. Do NOT initiate AI, follow-up, billing or
// outbound work from this reservation. No fallback to the legacy number.
async function reservePendingConversation({ accountId, phoneNumberId, customerPhone }, database = pool) {
  const account = digits(accountId, "Meta WhatsApp account ID");
  const phone = digits(phoneNumberId, "Meta receiving phone ID");
  const customer = customerId(customerPhone);
  const result = await database.query(
    "INSERT INTO whatsapp_sender_conversations (sender_id, customer_wa_id) " +
    "SELECT id, $3 FROM whatsapp_sender_accounts " +
    "WHERE meta_account_id = $1 AND meta_phone_number_id = $2 " +
    "AND state = 'active' " +
    "ON CONFLICT (sender_id, customer_wa_id) DO UPDATE " +
    "SET updated_at = whatsapp_sender_conversations.updated_at RETURNING *",
    [account, phone, customer]
  );
  return result.rows[0] || null;
}

async function findConversationBySender({ accountId, phoneNumberId, customerPhone }, database = pool) {
  const result = await database.query(
    "SELECT sc.*, sa.sender_key, sa.display_name, sa.meta_phone_number_id, " +
    "sa.meta_account_id, sa.state AS sender_state " +
    "FROM whatsapp_sender_conversations sc " +
    "JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id " +
    "WHERE sa.meta_account_id = $1 AND sa.meta_phone_number_id = $2 " +
    "AND sc.customer_wa_id = $3 AND sa.state = 'active'",
    [digits(accountId, "Meta WhatsApp account ID"),
      digits(phoneNumberId, "Meta receiving phone ID"), customerId(customerPhone)]
  );
  return result.rows[0] || null;
}

// Explicitly bind only a matching WhatsApp contact, after the verified
// legacy backfill. UNIQUE(contact_id) refuses cross-sender contact reuse.
async function bindExistingContact(conversationId, existingContactId, database = pool, env = process.env) {
  // Both the contact's sender identity and the conversation binding must
  // change in the SAME database statement, including primary legacy adoption.
  const result = await database.query(
    "WITH eligible AS MATERIALIZED (" +
    "SELECT sc.id AS conversation_id, sc.sender_id, sc.customer_wa_id, c.id AS contact_id " +
    "FROM whatsapp_sender_conversations sc " +
    "JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id AND sa.state='active' " +
    "JOIN contacts c ON c.id=$2 AND c.channel='whatsapp' " +
    "WHERE sc.id=$1 AND (sc.contact_id IS NULL OR sc.contact_id=c.id) " +
    "AND (c.whatsapp_number=sc.customer_wa_id OR " +
    "(c.whatsapp_number LIKE '0%' AND '60' || substring(c.whatsapp_number FROM 2)=sc.customer_wa_id)) " +
    "AND (c.whatsapp_sender_id=sc.sender_id OR " +
    "(c.whatsapp_sender_id IS NULL AND sa.meta_phone_number_id=$3 " +
    "AND sa.meta_account_id=$4)) FOR UPDATE OF sc,c" +
    "), adopted AS (" +
    "UPDATE contacts c SET whatsapp_sender_id=e.sender_id, " +
    "whatsapp_number=e.customer_wa_id, updated_at=NOW() FROM eligible e " +
    "WHERE c.id=e.contact_id AND (c.whatsapp_sender_id=e.sender_id " +
    "OR c.whatsapp_sender_id IS NULL) " +
    "RETURNING c.id, c.whatsapp_sender_id" +
    ") UPDATE whatsapp_sender_conversations sc " +
    "SET contact_id=$2,state='bound',updated_at=NOW() " +
    "FROM eligible e JOIN adopted a ON a.id=e.contact_id " +
    "AND a.whatsapp_sender_id=e.sender_id " +
    "WHERE sc.id=e.conversation_id AND sc.sender_id=e.sender_id " +
    "AND (sc.contact_id IS NULL OR sc.contact_id=a.id) RETURNING sc.*",
    [positiveId(conversationId), positiveId(existingContactId),
      String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
      String(env.WHATSAPP_WABA_ID || "").trim()]
  );
  return result.rows[0] || null;
}

// Atomic, sender-qualified contact claim. A customer contacting two business
// numbers owns two contacts and two independent AI/pipeline/opt-out histories.
// Nothing calls this on the legacy webhook until sender routing is verified.
async function claimSenderContact({
  accountId, phoneNumberId, customerPhone, profileName = null,
}, database = pool, env = process.env) {
  const account = digits(accountId, "Meta WhatsApp account ID");
  const phone = digits(phoneNumberId, "Meta receiving phone ID");
  const customer = customerId(customerPhone);
  const primaryPhone = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const primaryAccount = String(env.WHATSAPP_WABA_ID || "").trim();
  const isVerifiedPrimary = primaryPhone === phone && primaryAccount === account;
  if (phone === primaryPhone && !isVerifiedPrimary) {
    throw new Error("Primary WhatsApp sender account is not verified.");
  }
  if (typeof database.connect !== "function") {
    throw new Error("Sender-scoped claims require a transaction-capable database.");
  }
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const s = await client.query(
      "SELECT id, sender_key, display_name, meta_phone_number_id, meta_account_id " +
      "FROM whatsapp_sender_accounts WHERE meta_phone_number_id=$1 " +
      "AND meta_account_id=$2 AND state='active' FOR SHARE",
      [phone, account]
    );
    const sender = s.rows[0];
    if (!sender) throw new Error("WhatsApp sender is not authorized or enabled.");

    // Serialize claims for one sender/customer across workers and webhook retries.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [phone, customer]
    );
    let contact = (await client.query(
      "SELECT * FROM contacts WHERE channel='whatsapp' " +
      "AND whatsapp_sender_id=$1 AND whatsapp_number=$2 FOR UPDATE",
      [sender.id, customer]
    )).rows[0];

    if (!contact && isVerifiedPrimary) {
      // Preserve the original Neutro contact ID and historical data,
      // including Malaysian local 01x storage from older portal versions.
      // Never adopt a legacy contact for another business sender.
      const localNumber = /^60(1\d{8,9})$/.test(customer)
        ? "0" + customer.slice(2) : null;
      contact = (await client.query(
        "UPDATE contacts SET whatsapp_sender_id=$3, " +
        "whatsapp_number=$1, updated_at=NOW() " +
        "WHERE id = (SELECT id FROM contacts WHERE channel='whatsapp' " +
        "AND whatsapp_sender_id IS NULL AND whatsapp_number IN ($1,$2) " +
        "ORDER BY CASE WHEN whatsapp_number=$1 THEN 0 ELSE 1 END " +
        "LIMIT 1 FOR UPDATE) RETURNING *",
        [customer, localNumber, sender.id]
      )).rows[0];
    }

    if (!contact) {
      contact = (await client.query(
        "INSERT INTO contacts (whatsapp_number, whatsapp_profile_name, whatsapp_sender_id) " +
        "VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *",
        [customer, typeof profileName === "string" ? profileName.trim() || null : null, sender.id]
      )).rows[0];
      if (!contact) {
        contact = (await client.query(
          "SELECT * FROM contacts WHERE channel='whatsapp' " +
          "AND whatsapp_sender_id=$1 AND whatsapp_number=$2",
          [sender.id, customer]
        )).rows[0];
      }
    }
    if (!contact) throw new Error("Could not claim sender-scoped contact.");

    const bound = (await client.query(
      "INSERT INTO whatsapp_sender_conversations " +
      "(sender_id,customer_wa_id,contact_id,state) VALUES ($1,$2,$3,'bound') " +
      "ON CONFLICT (sender_id,customer_wa_id) DO UPDATE SET " +
      "contact_id=EXCLUDED.contact_id, state='bound', updated_at=NOW() " +
      "WHERE whatsapp_sender_conversations.contact_id IS NULL " +
      "OR whatsapp_sender_conversations.contact_id=EXCLUDED.contact_id " +
      "RETURNING id",
      [sender.id, customer, contact.id]
    )).rows[0];
    if (!bound) throw new Error("Sender conversation belongs to a different contact.");

    await client.query("COMMIT");
    return {
      ...contact,
      whatsapp_sender_key: sender.sender_key,
      whatsapp_sender_display_name: sender.display_name,
      whatsapp_sender_phone_number_id: sender.meta_phone_number_id,
      whatsapp_sender_account_id: sender.meta_account_id,
      whatsapp_sender_conversation_id: bound.id,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// A message may belong to exactly one sender conversation. This operation
// never changes a historic message or reassigns an existing sender context.
async function attachMessageContext({ messageId, contactId, conversationId }, database = pool) {
  const result = await database.query(
    "INSERT INTO whatsapp_sender_message_context (message_id, conversation_id) " +
    "SELECT m.id, sc.id FROM messages m " +
    "JOIN whatsapp_sender_conversations sc ON sc.contact_id = m.contact_id " +
    "JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id " +
    "WHERE m.id = $1 AND m.contact_id = $2 AND sc.id = $3 " +
    "AND sc.state = 'bound' AND sa.state = 'active' " +
    "ON CONFLICT (message_id) DO NOTHING RETURNING message_id, conversation_id",
    [positiveId(messageId), positiveId(contactId), positiveId(conversationId)]
  );
  if (result.rows[0]) return result.rows[0];
  // Only an identical previous association is safe to treat as a replay.
  const previous = await database.query(
    "SELECT x.message_id, x.conversation_id FROM whatsapp_sender_message_context x " +
    "JOIN messages m ON m.id = x.message_id " +
    "JOIN whatsapp_sender_conversations sc ON sc.id = x.conversation_id " +
    "WHERE x.message_id = $1 AND x.conversation_id = $2 " +
    "AND m.contact_id = $3 AND sc.contact_id = m.contact_id",
    [positiveId(messageId), positiveId(conversationId), positiveId(contactId)]
  );
  return previous.rows[0] || null;
}

async function senderForContact(existingContactId, database = pool) {
  const result = await database.query(
    "SELECT sc.id AS conversation_id, sc.customer_wa_id, sa.sender_key, " +
    "sa.meta_phone_number_id, sa.meta_account_id, sa.display_name, " +
    "sa.state AS sender_state FROM whatsapp_sender_conversations sc " +
    "JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id " +
    "WHERE sc.contact_id = $1 AND sc.state = 'bound'",
    [positiveId(existingContactId)]
  );
  return result.rows[0] || null;
}

module.exports = {
  reservePendingConversation,
  claimSenderContact,
  findConversationBySender,
  bindExistingContact,
  senderForContact,
  attachMessageContext,
};
