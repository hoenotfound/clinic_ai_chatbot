const { pool } = require("./db");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("../services/telegramImmediateAlertService");
const metaMessaging = require("../services/metaMessagingService");

const SOCIAL_CHANNELS = new Set(["facebook", "instagram"]);
const PROFILE_ENRICHMENT_WAIT_MS = 1200;

function normalizeWhatsappNumber(input) {
  let digits = String(input || "").replace(/[^\d]/g, "");
  if (!digits) return "";

  // Accept the common international dialing prefix form (e.g. 0060...)
  // without accidentally treating it as a Malaysian local number.
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  // Staff sometimes paste "+60 012..." with both the country code and the
  // Malaysian trunk zero. WhatsApp identifies the same number as 6012....
  if (digits.startsWith("600")) {
    digits = `60${digits.slice(3)}`;
  }

  // Malaysian local format: 012-345 6789 -> 60123456789.
  if (digits.startsWith("0")) {
    return `60${digits.slice(1)}`;
  }

  // Also accept a mobile number pasted without either the trunk zero or +60.
  // Malaysian mobile subscriber numbers are 9 or 10 digits and start with 1.
  if (/^1\d{8,9}$/.test(digits)) {
    return `60${digits}`;
  }

  // Already-canonical Malaysian numbers and explicit international numbers
  // are left untouched after punctuation/spacing is removed.
  return digits;
}

function legacyMalaysianLocalNumber(normalizedNumber) {
  const match = /^60(1\d{8,9})$/.exec(normalizedNumber);
  return match ? `0${match[1]}` : null;
}

function publishContactChange(id) {
  if (!id) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: id,
    reason: "contact_state",
  });
}

function notifyTelegram(promise, label, contactId) {
  Promise.resolve(promise).catch((err) => {
    console.error(`Telegram ${label} alert failed for contact ${contactId}:`, err);
  });
}

function socialChannelLabel(channel) {
  if (channel === "facebook") return "Facebook Messenger";
  if (channel === "instagram") return "Instagram";
  return null;
}

function socialFallbackName(channel) {
  if (channel === "facebook") return "Facebook user";
  if (channel === "instagram") return "Instagram user";
  return null;
}

function logSocialEnrichmentError(row, err) {
  console.warn(
    `Failed to enrich ${row.channel} contact ${row.channel_user_id}:`,
    err?.message || err
  );
}

async function persistSocialProfile(row, profile) {
  const profileName = profile?.profileName || null;
  const profilePhoto = profile?.photoUrl || null;
  if (!profileName && !profilePhoto) return row;

  const result = await pool.query(
    `UPDATE contacts
     SET whatsapp_profile_name = COALESCE($1, whatsapp_profile_name),
         photo_url = COALESCE($2, photo_url),
         updated_at = now()
     WHERE id = $3
       AND (
         ($1 IS NOT NULL AND whatsapp_profile_name IS DISTINCT FROM $1)
         OR ($2 IS NOT NULL AND photo_url IS DISTINCT FROM $2)
       )
     RETURNING whatsapp_profile_name, photo_url, updated_at`,
    [profileName, profilePhoto, row.contact_id || row.id]
  );

  const updated = result.rows[0];
  if (!updated) return row;
  publishContactChange(row.contact_id || row.id);
  return { ...row, ...updated };
}

async function hydrateSocialContactRow(row) {
  if (!row || !SOCIAL_CHANNELS.has(row.channel) || !row.channel_user_id) {
    return row;
  }

  try {
    // Always ask the cached Meta profile helper for social contacts. Its six-hour
    // cache makes normal reads cheap, while still allowing expiring Instagram
    // profile-photo URLs and changed platform names to be refreshed over time.
    const profilePromise = metaMessaging.fetchUserProfile(
      row.channel,
      row.channel_user_id
    );

    let timer = null;
    const quickResult = await Promise.race([
      profilePromise.then((profile) => ({ timedOut: false, profile })),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ timedOut: true, profile: null }),
          PROFILE_ENRICHMENT_WAIT_MS
        );
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (quickResult.timedOut) {
      // Profile data is presentation-only. Never hold the Inbox/Contacts API
      // open for Meta longer than a short grace period. If Meta finishes later,
      // persist the result and publish an Inbox refresh event in the background.
      profilePromise
        .then((profile) => persistSocialProfile(row, profile))
        .catch((err) => logSocialEnrichmentError(row, err));
      return row;
    }

    return await persistSocialProfile(row, quickResult.profile);
  } catch (err) {
    // Profile enrichment must never stop the Inbox/Contacts APIs from loading.
    logSocialEnrichmentError(row, err);
    return row;
  }
}

async function hydrateSocialContactRows(rows) {
  return Promise.all((rows || []).map((row) => hydrateSocialContactRow(row)));
}

function presentPortalContact(row) {
  if (!SOCIAL_CHANNELS.has(row?.channel)) return row;

  return {
    ...row,
    // whatsapp_number is an internal NOT NULL compatibility key for social
    // contacts (for example "facebook:<PSID>"). Never expose that storage key
    // to the staff portal as though it were a phone number.
    whatsapp_number: socialChannelLabel(row.channel),
    whatsapp_profile_name:
      row.whatsapp_profile_name || socialFallbackName(row.channel),
  };
}

async function reconcileLegacyWhatsappContact(normalizedNumber, profileName) {
  const legacyNumber = legacyMalaysianLocalNumber(normalizedNumber);
  if (!legacyNumber) return null;

  try {
    const result = await pool.query(
      `UPDATE contacts AS legacy
       SET whatsapp_number = $1,
           whatsapp_profile_name = COALESCE($3, legacy.whatsapp_profile_name),
           updated_at = now()
       WHERE legacy.whatsapp_number = $2
         AND NOT EXISTS (
           SELECT 1
           FROM contacts AS canonical
           WHERE canonical.whatsapp_number = $1
         )
       RETURNING legacy.*`,
      [normalizedNumber, legacyNumber, profileName]
    );
    const reconciled = result.rows[0] || null;
    if (reconciled) publishContactChange(reconciled.id);
    return reconciled;
  } catch (err) {
    // Another request may have inserted the canonical number after the
    // NOT EXISTS check. The unique constraint is the final arbiter; fall
    // through to the normal canonical lookup instead of failing the webhook.
    if (err.code === "23505") return null;
    throw err;
  }
}

async function getOrCreateContact(whatsappNumber, whatsappProfileName = null) {
  const normalizedNumber = normalizeWhatsappNumber(whatsappNumber);
  const profileName = whatsappProfileName?.trim() || null;

  // Older portal versions allowed Malaysian local numbers such as 012... to
  // be stored verbatim. Reuse that same contact before inserting the canonical
  // WhatsApp 6012... form, otherwise the next inbound message creates a duplicate.
  const reconciled = await reconcileLegacyWhatsappContact(normalizedNumber, profileName);
  if (reconciled) return reconciled;

  const inserted = await pool.query(
    `INSERT INTO contacts (whatsapp_number, whatsapp_profile_name)
     VALUES ($1, $2)
     ON CONFLICT (whatsapp_number) DO NOTHING
     RETURNING *`,
    [normalizedNumber, profileName]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  if (profileName) {
    const updated = await pool.query(
      `UPDATE contacts
       SET whatsapp_profile_name = $2, updated_at = now()
       WHERE whatsapp_number = $1
         AND whatsapp_profile_name IS DISTINCT FROM $2
       RETURNING *`,
      [normalizedNumber, profileName]
    );
    if (updated.rows[0]) return updated.rows[0];
  }

  const existing = await pool.query(
    "SELECT * FROM contacts WHERE whatsapp_number = $1",
    [normalizedNumber]
  );
  return existing.rows[0];
}

/**
 * Creates or refreshes a Facebook/Instagram contact without changing the
 * existing WhatsApp identity path. whatsapp_number stays NOT NULL for legacy
 * code by holding a namespaced internal key; channel_user_id is the actual
 * PSID/IGSID used by the social messaging APIs.
 */
async function getOrCreateChannelContact(
  channel,
  channelUserId,
  channelProfileName = null,
  photoUrl = null
) {
  if (!SOCIAL_CHANNELS.has(channel)) {
    throw new Error(`Unsupported social channel: ${channel}`);
  }

  const externalId = String(channelUserId || "").trim();
  if (!externalId) throw new Error(`${channel} contact id is required.`);

  const storageKey = `${channel}:${externalId}`;
  const profileName = channelProfileName?.trim() || null;
  const profilePhoto = photoUrl?.trim() || null;

  const result = await pool.query(
    `INSERT INTO contacts (
       whatsapp_number, whatsapp_profile_name, channel, channel_user_id, photo_url
     )
     VALUES ($1, $4, $2, $3, $5)
     ON CONFLICT (whatsapp_number) DO UPDATE
     SET channel = EXCLUDED.channel,
         channel_user_id = EXCLUDED.channel_user_id,
         whatsapp_profile_name = COALESCE(EXCLUDED.whatsapp_profile_name, contacts.whatsapp_profile_name),
         photo_url = COALESCE(EXCLUDED.photo_url, contacts.photo_url),
         updated_at = CASE
           WHEN contacts.channel IS DISTINCT FROM EXCLUDED.channel
             OR contacts.channel_user_id IS DISTINCT FROM EXCLUDED.channel_user_id
             OR (EXCLUDED.whatsapp_profile_name IS NOT NULL
                 AND contacts.whatsapp_profile_name IS DISTINCT FROM EXCLUDED.whatsapp_profile_name)
             OR (EXCLUDED.photo_url IS NOT NULL
                 AND contacts.photo_url IS DISTINCT FROM EXCLUDED.photo_url)
           THEN now()
           ELSE contacts.updated_at
         END
     RETURNING *`,
    [storageKey, channel, externalId, profileName, profilePhoto]
  );

  return result.rows[0];
}

async function getContactById(id) {
  const result = await pool.query("SELECT * FROM contacts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function updateContactName(id, name) {
  const result = await pool.query(
    "UPDATE contacts SET name = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [name || null, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function listContacts(search) {
  const term = (search || "").trim();
  const params = term ? [`%${term}%`] : [];
  const result = await pool.query(
    `
    SELECT
      c.id, c.whatsapp_number, c.name, c.whatsapp_profile_name, c.mode, c.needs_attention,
      c.is_unread, c.needs_follow_up, c.created_at, c.updated_at,
      c.channel, c.channel_user_id, c.photo_url,
      COUNT(m.id)::int AS message_count,
      MAX(m.created_at) AS last_message_at
    FROM contacts c
    LEFT JOIN messages m ON m.contact_id = c.id
    ${term ? "WHERE c.name ILIKE $1 OR c.whatsapp_profile_name ILIKE $1 OR c.whatsapp_number ILIKE $1 OR c.channel_user_id ILIKE $1" : ""}
    GROUP BY c.id
    ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
    `,
    params
  );
  const hydrated = await hydrateSocialContactRows(result.rows);
  return hydrated.map((row) => presentPortalContact(row));
}

async function createContact({ name, whatsappNumber }) {
  const result = await pool.query(
    "INSERT INTO contacts (name, whatsapp_number) VALUES ($1, $2) RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber)]
  );
  return result.rows[0];
}

async function updateContact(id, { name, whatsappNumber }) {
  const result = await pool.query(
    "UPDATE contacts SET name = $1, whatsapp_number = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber), id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function listConversations() {
  const result = await pool.query(
    `
    SELECT
      c.id AS contact_id,
      c.whatsapp_number,
      c.name,
      c.whatsapp_profile_name,
      c.channel,
      c.channel_user_id,
      c.photo_url,
      c.mode,
      c.takeover_by,
      c.takeover_at,
      c.needs_attention,
      c.attention_reason,
      c.is_unread,
      c.needs_follow_up,
      m.content AS last_message,
      m.role AS last_message_role,
      m.media_url AS last_message_media_url,
      m.created_at AS last_message_at,
      EXISTS (
        SELECT 1
        FROM messages inbound
        WHERE inbound.contact_id = c.id
          AND inbound.role = 'user'
          AND NOT EXISTS (
            SELECT 1
            FROM messages outbound
            WHERE outbound.contact_id = c.id
              AND outbound.role = 'assistant'
              AND (
                outbound.delivery_status IS NULL
                OR outbound.delivery_status NOT IN ('failed', 'unknown')
              )
              AND (outbound.created_at, outbound.id) > (inbound.created_at, inbound.id)
          )
      ) AS has_unreplied
    FROM contacts c
    JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE contact_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
    )
    ORDER BY c.needs_attention DESC, m.created_at DESC
    `
  );
  const hydrated = await hydrateSocialContactRows(result.rows);
  return hydrated.map((row) => presentPortalContact(row));
}

async function takeOver(id, staffUsername) {
  const result = await pool.query(
    `UPDATE contacts
     SET mode = 'human', takeover_by = $1, takeover_at = now(),
         needs_attention = false, attention_reason = NULL, is_unread = false,
         updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [staffUsername, id]
  );
  const updated = result.rows[0] || null;
  // Keep the existing Telegram cooldown while staff owns the chat. Otherwise
  // the very next customer message in human mode could immediately generate a
  // second intervention alert for the same unresolved conversation.
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function returnToAi(id) {
  const result = await pool.query(
    `UPDATE contacts
     SET mode = 'ai', takeover_by = NULL, takeover_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  const updated = result.rows[0] || null;
  // Human-intervention Telegram alerts use a strict rolling 30-minute
  // per-contact cooldown. Returning to AI must not reopen that window early.
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function setAttention(id, needsAttention, reason = null) {
  const result = await pool.query(
    `UPDATE contacts c
     SET needs_attention = $1, attention_reason = $2, updated_at = now()
     WHERE c.id = $3
     RETURNING c.*,
       (SELECT m.id FROM messages m
        WHERE m.contact_id = c.id AND m.role = 'user'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS attention_message_id`,
    [needsAttention, needsAttention ? reason : null, id]
  );
  const updated = result.rows[0] || null;
  if (updated) {
    // Clearing an Inbox attention flag is operational state only. It must not
    // reset the Telegram anti-spam window for this contact.
    publishContactChange(updated.id);
    if (needsAttention) {
      notifyTelegram(
        telegramImmediateAlerts.sendHumanInterventionAlert({
          contactId: updated.id,
          messageId: updated.attention_message_id,
          reason: updated.attention_reason || reason || "Human review requested.",
        }),
        "human intervention",
        updated.id
      );
    }
  }
  return updated;
}

// Delivery problems should not replace a more important reason that already
// needs staff attention, such as an urgent keyword or an AI handoff. Repeated
// delivery failures may update the existing delivery reason with newer detail.
async function setDeliveryAttention(id, reason) {
  const result = await pool.query(
    `UPDATE contacts
     SET needs_attention = true, attention_reason = $1, updated_at = now()
     WHERE id = $2
       AND (
         needs_attention = false
         OR attention_reason IS NULL
         OR attention_reason LIKE 'Delivery failed:%'
         OR attention_reason LIKE 'Delivery unconfirmed:%'
       )
     RETURNING *`,
    [reason, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);

  // A delivery failure is worth surfacing even when a more important human
  // attention reason is already protecting the contact row from being replaced.
  notifyTelegram(
    telegramImmediateAlerts.sendDeliveryFailureAlert({ contactId: id, reason }),
    "delivery failure",
    id
  );

  return updated;
}

// Clears only a delivery attention flag and only when no failed or unconfirmed
// outbound messages remain. Keeping both conditions in the same SQL statement
// prevents a successful retry from clearing a newer keyword, handoff, or
// staff-owned-message warning that arrived while the retry was in progress.
async function clearDeliveryAttentionIfNoFailedMessages(id) {
  const result = await pool.query(
    `UPDATE contacts c
     SET needs_attention = false, attention_reason = NULL, updated_at = now()
     WHERE c.id = $1
       AND c.needs_attention = true
       AND (
         c.attention_reason LIKE 'Delivery failed:%'
         OR c.attention_reason LIKE 'Delivery unconfirmed:%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.contact_id = c.id
           AND m.role = 'assistant'
           AND m.delivery_status IN ('failed', 'unknown')
       )
     RETURNING *`,
    [id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function setUnread(id, isUnread) {
  const result = await pool.query(
    `UPDATE contacts
     SET is_unread = $1, updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [isUnread, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function setFollowUp(id, needsFollowUp) {
  const result = await pool.query(
    `UPDATE contacts
     SET needs_follow_up = $1, updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [needsFollowUp, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

module.exports = {
  getOrCreateContact,
  getOrCreateChannelContact,
  getContactById,
  updateContactName,
  listConversations,
  listContacts,
  createContact,
  updateContact,
  normalizeWhatsappNumber,
  presentPortalContact,
  takeOver,
  returnToAi,
  setAttention,
  setDeliveryAttention,
  clearDeliveryAttentionIfNoFailedMessages,
  setUnread,
  setFollowUp,
};
