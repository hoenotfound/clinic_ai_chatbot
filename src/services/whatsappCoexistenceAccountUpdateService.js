"use strict";

// Account-update events arrive on Meta's APP-LEVEL WhatsApp callback. The raw
// payload is used only after createApp's HMAC middleware verified it. No
// customer text, tokens, or personal details are stored in the audit table.
const crypto = require("node:crypto");
const { pool } = require("../db/db");

const EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED", "ACCOUNT_RECONNECTED"]);
const DISCONNECTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"]);
function digits(value) { return String(value || "").replace(/[^0-9]/g, ""); }
function fingerprint(accountId, change, entryTime = null) {
  // WhatsApp account_update carries entry.time (Unix seconds). It separates
  // two independent disconnect occurrences with identical reason/initiator.
  return crypto.createHash("sha256")
    .update(JSON.stringify({
      account: accountId, change,
      ...(Number.isSafeInteger(entryTime) && entryTime > 0 ? { time: entryTime } : {}),
    })).digest("hex");
}
function extractSecondaryLifecycle(body, env = process.env) {
  if (env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED !== "true") return [];
  const account = String(env.WHATSAPP_SECONDARY_WABA_ID || "").trim();
  const phoneId = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "").trim();
  const number = digits(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164);
  // Account ownership, receiver identity and E164 must all be pinned. Do
  // not react to an unrelated account_update or primary-number callback.
  if (!/^\d+$/.test(account) || !/^\d+$/.test(phoneId) ||
      !/^\d{8,15}$/.test(number) || !Array.isArray(body?.entry)) return [];
  const events = [];
  for (const entry of body.entry) {
    if (String(entry?.id || "") !== account) continue;
    for (const change of entry?.changes || []) {
      if (change?.field !== "account_update" ||
          !EVENTS.has(change.value?.event)) continue;
      const indicated = change.value?.phone_number;
      const normalized = digits(indicated);
      // A phone-specific update must match the configured secondary E164.
      // Account-wide events lacking phone_number may still require a
      // conservative suspension of the pinned secondary sender.
      if (indicated !== undefined && (!normalized || normalized !== number)) continue;
      const entryTime = Number(entry.time);
      events.push(Object.freeze({
        fingerprint: fingerprint(entry.id, change, entry.time == null ? null : entryTime),
        // The legacy quarantine partition hashes without the entry timestamp.
        quarantineFingerprint: fingerprint(entry.id, change),
        accountId: account, phoneNumberId: phoneId, phoneNumber: normalized || null,
        eventType: change.value.event,
      }));
    }
  }
  if (events.length > 200) throw Error("Coexistence lifecycle event limit exceeded.");
  return events;
}

async function persistSecondaryLifecycle(events, {
  database = pool, env = process.env,
} = {}) {
  if (!events?.length) return { accepted: true, count: 0 };
  const account = String(env.WHATSAPP_SECONDARY_WABA_ID || "");
  const phone = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "");
  const key = String(env.WHATSAPP_SECONDARY_SENDER_KEY || "");
  if (!/^\d+$/.test(account) || !/^\d+$/.test(phone) || !key ||
      typeof database?.connect !== "function") throw Error("Secondary lifecycle sender unavailable");
  const client = await database.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const found = await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 " +
      "AND meta_account_id=$2 AND meta_phone_number_id=$3 FOR UPDATE",
      [key, account, phone]
    );
    if (found.rows?.length !== 1) throw Error("Secondary lifecycle sender identity mismatch");
    const senderId = found.rows[0].id;
    let count = 0;
    for (const event of events) {
      if (event.accountId !== account || event.phoneNumberId !== phone ||
          !EVENTS.has(event.eventType) || !/^[a-f0-9]{64}$/.test(event.fingerprint)) {
        throw Error("Invalid secondary lifecycle event identity");
      }
      const disabled = DISCONNECTS.has(event.eventType);
      const recorded = await client.query(
        "INSERT INTO whatsapp_sender_coexistence_lifecycle_events " +
        "(fingerprint,sender_id,event_type,account_id,phone_number,action) " +
        "VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint",
        [event.fingerprint, senderId, event.eventType, account,
          event.phoneNumber, disabled ? "disabled" : "reconnect_review"]
      );
      if (recorded.rowCount === 1) count++;
      if (disabled) {
        // Never let a previously seen fingerprint become an exemption from a
        // later disconnect. After an authorized manual reactivation, an
        // identical signed PARTNER_REMOVED is still a valid stop signal.
        // A stale replay may conservatively suspend sending again; that is
        // safer than silently leaving an unlinked secondary active.
        // Only the exact pinned SECONDARY row can be changed.
        await client.query(
          "UPDATE whatsapp_sender_accounts SET state='disabled', " +
          "coexistence_enabled=FALSE, updated_at=NOW() " +
          "WHERE id=$1 AND (state <> 'disabled' OR coexistence_enabled=TRUE)",
          [senderId]
        );
      }
      // ACCOUNT_RECONNECTED is only evidence for a human review. NEVER
      // reactivate automatically from an untrusted or out-of-order callback.
    }
    await client.query("COMMIT"); began = false;
    return { accepted: true, count };
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
module.exports = { extractSecondaryLifecycle, persistSecondaryLifecycle, fingerprint };
