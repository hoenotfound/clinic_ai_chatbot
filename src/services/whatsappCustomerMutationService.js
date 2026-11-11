"use strict";

// These provider-authenticated events must never create AI turns, appointments,
// lead scoring or marketing consent. An event can precede its original message.
const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");

const WAMID = /^wamid\.[A-Za-z0-9._:+/=-]{1,512}$/;
const MIN_TIMESTAMP = 946684800; // 2000-01-01
const MAX_TEXT = 4096;
const DELETED_TEXT = "🗑️ [This message was deleted]";
const UNAVAILABLE_TEXT = "✏️ [Customer edited this message; WhatsApp did not provide the updated text]";
const NOTICE_TEXT = "✏️ [Customer edited a message; updated text unavailable from WhatsApp]";

function supportedSender(event, env = process.env) {
  const account = String(event?.businessAccountId || "");
  const phone = String(event?.businessPhoneNumberId || "");
  if (!/^[0-9]+$/.test(account) || !/^[0-9]+$/.test(phone)) return false;
  return (account === env.WHATSAPP_WABA_ID && phone === env.WHATSAPP_PHONE_NUMBER_ID) ||
    (account === env.WHATSAPP_SECONDARY_WABA_ID &&
     phone === env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID &&
     env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED === "true");
}

function normalize(event, env = process.env) {
  if (!supportedSender(event, env) || !WAMID.test(String(event?.id || ""))) return null;
  const action = event.action;
  if (!["edit", "revoke", "edit_unavailable", "unavailable_edit"].includes(action)) return null;
  const target = event.originalMessageId || null;
  if ((action === "unavailable_edit") !== (target === null) ||
      (target && !WAMID.test(target))) return null;
  const from = String(event.from || "").trim();
  const customerUserId = String(event.customerUserId || "").trim() || null;
  if (!from || from.length > 256 || (customerUserId && customerUserId.length > 256)) return null;
  if (action === "edit" && (typeof event.replacementText !== "string" ||
      event.replacementText.length > MAX_TEXT)) return null;
  let timestamp = Number(event.timestamp);
  if (!Number.isSafeInteger(timestamp) ||
      timestamp < MIN_TIMESTAMP || timestamp > Math.floor(Date.now()/1000) + 86400) {
    timestamp = Math.floor(Date.now()/1000);
  }
  return {
    id: event.id, target, action, from, customerUserId,
    text: action === "edit" ? event.replacementText : null,
    account: event.businessAccountId,
    phone: event.businessPhoneNumberId,
    timestamp,
  };
}

const SENDER_MATCH = `(
 (c.whatsapp_sender_id IS NOT NULL AND
  sa.meta_phone_number_id = $2 AND sa.meta_account_id = $3 AND sa.state = 'active')
 OR
 (c.whatsapp_sender_id IS NULL AND $2 = $6 AND $3 = $7)
)`;
const CUSTOMER_MATCH = `(
 c.whatsapp_number = $4 OR c.whatsapp_user_id = $4 OR
 c.whatsapp_last_customer_address = $4 OR
 ($5 IS NOT NULL AND (c.whatsapp_number = $5 OR
   c.whatsapp_user_id = $5 OR c.whatsapp_last_customer_address = $5))
)`;

function params(event, env = process.env) {
  return [
    event.target || null, event.phone, event.account,
    event.from, event.customerUserId,
    env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_WABA_ID,
  ];
}

function publish(contactId, messageId, phone, message = null) {
  realtimeEvents.publish("conversation_changed", {
    contactId, messageId, reason: message ? "message_mutation" : "message",
    ...(message ? {message} : {}),
    channel: "whatsapp", businessPhoneNumberId: phone,
    followUpStateUnchanged: true,
  });
}

async function applyOne(eventId, {database = pool, env = process.env} = {}) {
  const client = await database.connect();
  let changed = null;
  try {
    await client.query("BEGIN");
    const {rows} = await client.query(
      "SELECT * FROM whatsapp_customer_message_mutations WHERE event_wamid=$1 FOR UPDATE",
      [eventId]
    );
    const event = rows[0];
    if (!event || event.status !== "pending" || !event.target_wamid) {
      await client.query("COMMIT");
      return null;
    }
    const queryParams = params({
      target: event.target_wamid, phone: event.business_phone_number_id,
      account: event.business_account_id, from: event.customer_address,
      customerUserId: event.customer_user_id,
    }, env);
    const match = await client.query(
      `SELECT m.id, m.contact_id, m.whatsapp_customer_mutation,
              m.whatsapp_customer_mutated_at
         FROM messages m
         JOIN contacts c ON c.id = m.contact_id AND c.channel = 'whatsapp'
         LEFT JOIN whatsapp_sender_accounts sa ON sa.id = c.whatsapp_sender_id
        WHERE m.whatsapp_message_id = $1 AND m.role = 'user'
          AND ${SENDER_MATCH} AND ${CUSTOMER_MATCH}
        FOR UPDATE OF m`,
      queryParams
    );
    const message = match.rows[0];
    if (!message) {
      await client.query("COMMIT");
      return null; // Retain for an out-of-order original.
    }

    const providerMs = Number(event.provider_timestamp) * 1000;
    const previousMs = message.whatsapp_customer_mutated_at
      ? new Date(message.whatsapp_customer_mutated_at).getTime() : 0;
    const allowed = message.whatsapp_customer_mutation !== "revoke" &&
      (event.action === "revoke" || providerMs >= previousMs);
    if (allowed) {
      const replaceMedia = event.action !== "edit";
      const newContent = event.action === "revoke" ? DELETED_TEXT :
        event.action === "edit_unavailable" ? UNAVAILABLE_TEXT : event.replacement_text;
      const update = await client.query(
        `UPDATE messages
            SET content=$3, whatsapp_customer_mutation=$4,
                whatsapp_customer_mutated_at=to_timestamp($5),
                media_key=CASE WHEN $6 THEN NULL ELSE media_key END,
                media_base64=CASE WHEN $6 THEN NULL ELSE media_base64 END,
                media_mime_type=CASE WHEN $6 THEN NULL ELSE media_mime_type END,
                media_filename=CASE WHEN $6 THEN NULL ELSE media_filename END,
                media_url=CASE WHEN $6 THEN NULL ELSE media_url END
          WHERE id=$1 AND contact_id=$2 AND role='user'
          RETURNING id`,
        [message.id, message.contact_id, newContent, event.action,
         Number(event.provider_timestamp), replaceMedia]
      );
      if (update.rows.length === 1) {
        changed = {
          contactId: message.contact_id, messageId: message.id,
          phone: event.business_phone_number_id,
          message: {
            id: message.id, content: newContent,
            whatsapp_customer_mutation: event.action,
            ...(replaceMedia ? {media_url:null,media_mime_type:null,
              media_filename:null,has_media_attachment:false} : {}),
          }
        };
      }
    }
    await client.query(
      `UPDATE whatsapp_customer_message_mutations
          SET status='applied', replacement_text=NULL, target_message_id=$2,
              updated_at=NOW()
        WHERE event_wamid=$1`,
      [eventId, message.id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (changed) publish(changed.contactId, changed.messageId, changed.phone, changed.message);
  return changed;
}

async function reconcileForOriginal(wamid, {database = pool, env = process.env} = {}) {
  if (!WAMID.test(String(wamid || ""))) return 0;
  const {rows} = await database.query(
    `SELECT event_wamid FROM whatsapp_customer_message_mutations
      WHERE target_wamid=$1 AND status='pending'
      ORDER BY provider_timestamp, event_wamid LIMIT 30`,
    [wamid]
  );
  let applied = 0;
  for (const row of rows) {
    if (await applyOne(row.event_wamid, {database, env})) applied++;
  }
  return applied;
}

async function applyUnavailableNotice(event, {database = pool, env = process.env} = {}) {
  const qp = params(event, env);
  const existing = await database.query(
    `SELECT c.id FROM contacts c
      LEFT JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
      WHERE c.channel='whatsapp' AND $1::text IS NULL
        AND ${SENDER_MATCH} AND ${CUSTOMER_MATCH}
      ORDER BY c.id DESC LIMIT 1`, qp
  );
  const contactId = existing.rows[0]?.id;
  if (!contactId) return null; // No new contact may be created by a mutation.
  const created = await database.query(
    `INSERT INTO messages(contact_id,role,content,whatsapp_message_id,
                          whatsapp_customer_mutation,whatsapp_customer_mutated_at)
      VALUES($1,'user',$2,$3,'unavailable_edit',to_timestamp($4))
      ON CONFLICT(whatsapp_message_id) DO NOTHING RETURNING id,contact_id`,
    [contactId, NOTICE_TEXT, event.id, event.timestamp]
  );
  // A retry is harmless. Do not overwrite an existing customer turn.
  const messageId = created.rows[0]?.id ||
    (await database.query(
      `SELECT id FROM messages WHERE whatsapp_message_id=$1
        AND contact_id=$2 AND whatsapp_customer_mutation='unavailable_edit'`,
      [event.id, contactId])).rows[0]?.id;
  if (!messageId) throw Error("Mutation notice conflicts with a customer message");
  await database.query(
    `UPDATE whatsapp_customer_message_mutations
      SET status='applied',target_message_id=$2,replacement_text=NULL,updated_at=NOW()
      WHERE event_wamid=$1 AND status='pending'`,
    [event.id,messageId]
  );
  if (created.rows.length) publish(contactId, messageId, event.phone);
  return {contactId,messageId};
}

async function record(rawEvent, {database = pool, env = process.env} = {}) {
  const event = normalize(rawEvent, env);
  if (!event) return null; // Provider anomalies cannot become customer text.
  await database.query(
    `INSERT INTO whatsapp_customer_message_mutations(
       event_wamid,target_wamid,business_phone_number_id,business_account_id,
       customer_address,customer_user_id,action,replacement_text,provider_timestamp)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(event_wamid) DO NOTHING`,
    [event.id,event.target,event.phone,event.account,event.from,
     event.customerUserId,event.action,event.text,event.timestamp]
  );
  if (event.action === "unavailable_edit") {
    return applyUnavailableNotice(event, {database, env});
  }
  return applyOne(event.id, {database,env});
}

module.exports = {
  normalize, record, reconcileForOriginal, applyOne, applyUnavailableNotice,
  DELETED_TEXT, UNAVAILABLE_TEXT, NOTICE_TEXT,
};
