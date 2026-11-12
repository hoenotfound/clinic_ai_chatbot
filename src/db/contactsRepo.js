const { pool } = require("./db");
const { secondaryLegacyStaffCutoff } = require("../services/whatsappSecondaryLegacyStaffPolicy");
const { normalizeWhatsappNumber } = require("../utils/whatsappPhoneNormalization");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const realtimeEvents = require("../utils/realtimeEvents");
const { scopeForPersistedContact } = require("../utils/verifiedWhatsAppEventScope");
const telegramImmediateAlerts = require("../services/telegramImmediateAlertService");
const webPushNotifications = require("../services/webPushNotificationService");
const metaMessaging = require("../services/metaMessagingService");
const { humanAgentChannelEnabled } = require("../utils/metaHumanAgent");
const { acceptedNormalOutboundSql } = require("../utils/normalOutboundProofSql");
const { createInboxTreatmentResolver } = require("../utils/inboxTreatmentInterest");
const { acceptedDirectReplySql, failedMediaSql, unresolvedFailedOutboundSql } = require("../utils/deliveryReplyAttentionSql");

const SOCIAL_CHANNELS = new Set(["facebook", "instagram"]);
const PROFILE_ENRICHMENT_WAIT_MS = 1200;

function legacyMalaysianLocalNumber(normalizedNumber) {
  const match = /^60(1\d{8,9})$/.exec(normalizedNumber);
  return match ? `0${match[1]}` : null;
}

function publishContactChange(id, { profileOnly = false, contact = null } = {}) {
  if (!id) return;
  realtimeEvents.publish("conversation_changed", {
    // No lookup: only a verified, already loaded sender record can scope this
    // event. Missing sender fields remain unknown and fail closed.
    ...scopeForPersistedContact(contact),
    contactId: id,
    reason: "contact_state",
    // Profile name/photo updates change the Inbox display only.
    // Preserve the event; avoid an unnecessary follow-up eligibility sweep.
    ...(profileOnly ? { followUpStateUnchanged: true } : {}),
  });
}

function notifyTelegram(promise, label, contactId) {
  Promise.resolve(promise).catch((err) => {
    console.error(`Telegram ${label} alert failed for contact ${contactId}:`, err);
  });
}

function notifyWebPush(contactId, type) {
  webPushNotifications.sendContactAlertBestEffort({ contactId, type });
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
     SET whatsapp_profile_name = COALESCE($1::text, whatsapp_profile_name),
         photo_url = COALESCE($2::text, photo_url),
         updated_at = now()
     WHERE id = $3
       AND (
         ($1::text IS NOT NULL AND whatsapp_profile_name IS DISTINCT FROM $1::text)
         OR ($2::text IS NOT NULL AND photo_url IS DISTINCT FROM $2::text)
       )
     RETURNING whatsapp_profile_name, photo_url, updated_at`,
    [profileName, profilePhoto, row.contact_id || row.id]
  );

  const updated = result.rows[0];
  if (!updated) return row;
  publishContactChange(row.contact_id || row.id, { profileOnly: true, contact: row });
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
  const isSocial = SOCIAL_CHANNELS.has(row?.channel);
  if (!isSocial) {
    // Legacy Neutro contacts deliberately remain unbound in migration 080.
    // This is a PRESENTATION alias only, never an identity or send credential:
    // the original contact and primary billing proof remain untouched.
    const primaryKey = String(process.env.WHATSAPP_PRIMARY_SENDER_KEY || "");
    if (row?.channel === "whatsapp" && row.whatsapp_sender_id == null &&
        !row.whatsapp_sender_key &&
        process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true" &&
        process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED === "true" &&
        /^[a-z][a-z0-9_-]{0,63}$/.test(primaryKey) &&
        /^[0-9]+$/.test(String(process.env.WHATSAPP_PHONE_NUMBER_ID || "")) &&
        /^[0-9]+$/.test(String(process.env.WHATSAPP_WABA_ID || ""))) {
      return { ...row, whatsapp_sender_key: primaryKey,
        whatsapp_sender_display_name: "Neutro Sense",
        whatsapp_sender_phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID,
        whatsapp_sender_account_id: process.env.WHATSAPP_WABA_ID,
        whatsapp_is_secondary: false };
    }
    return row;
  }

  return {
    ...row,
    human_agent_enabled: humanAgentChannelEnabled(row.channel),
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
         AND legacy.whatsapp_sender_id IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM contacts AS canonical
           WHERE canonical.whatsapp_number = $1
             AND canonical.whatsapp_sender_id IS NULL
         )
       RETURNING legacy.*`,
      [normalizedNumber, legacyNumber, profileName]
    );
    const reconciled = result.rows[0] || null;
    if (reconciled) publishContactChange(reconciled.id, { contact: reconciled });
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
     SELECT $1, $2
     WHERE NOT EXISTS (
       SELECT 1 FROM contacts tagged
       WHERE tagged.whatsapp_number=$1 AND tagged.channel='whatsapp'
         AND tagged.whatsapp_sender_id IS NOT NULL
     )
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [normalizedNumber, profileName]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  if (profileName) {
    const updated = await pool.query(
      `UPDATE contacts
       SET whatsapp_profile_name = $2, updated_at = now()
       WHERE whatsapp_number = $1 AND whatsapp_sender_id IS NULL
         AND whatsapp_profile_name IS DISTINCT FROM $2
       RETURNING *`,
      [normalizedNumber, profileName]
    );
    if (updated.rows[0]) return updated.rows[0];
  }

  const existing = await pool.query(
    "SELECT * FROM contacts WHERE whatsapp_number = $1 AND whatsapp_sender_id IS NULL",
    [normalizedNumber]
  );
  if (existing.rows[0]) return existing.rows[0];
  // Rollback/read-only deployments must reuse the old Neutro contact after
  // sender adoption. Never silently create a new null-sender duplicate.
  const scoped = await pool.query(
    "SELECT c.*,sa.sender_key AS whatsapp_sender_key, " +
    "sa.meta_phone_number_id AS whatsapp_sender_phone_number_id, " +
    "sa.meta_account_id AS whatsapp_sender_account_id, " +
    "sa.state AS whatsapp_sender_state, " +
    "sa.coexistence_enabled AS whatsapp_sender_coexistence_enabled " +
    "FROM contacts c " +
    "JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id " +
    "WHERE c.channel='whatsapp' AND c.whatsapp_number=$1 " +
    "AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3 " +
    "LIMIT 1",
    [normalizedNumber, String(process.env.WHATSAPP_PHONE_NUMBER_ID || ""),
      String(process.env.WHATSAPP_WABA_ID || "")]
  );
  if (scoped.rows[0]) return scoped.rows[0];
  const mismatched = await pool.query(
    "SELECT 1 FROM contacts WHERE whatsapp_number=$1 " +
    "AND channel='whatsapp' AND whatsapp_sender_id IS NOT NULL LIMIT 1",
    [normalizedNumber]
  );
  if (mismatched.rows[0]) {
    throw new Error("Legacy WhatsApp contact is already assigned to an unverified sender.");
  }
  return null;
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
     ON CONFLICT (channel, channel_user_id) WHERE channel_user_id IS NOT NULL DO UPDATE
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

// Read new sender tables only after an explicit staged activation.
// Legacy installations and narrow test schemas retain the original SQL.
// This switch must stay OFF until the full multi-number send paths are ready.
function senderAwareInboxReadsEnabled() {
  return process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED === "true";
}

async function getContactById(id) {
  const result = await pool.query(senderAwareInboxReadsEnabled() ?
    "SELECT c.*, sa.sender_key AS whatsapp_sender_key, " +
    "sa.display_name AS whatsapp_sender_display_name, " +
    "sa.meta_phone_number_id AS whatsapp_sender_phone_number_id, " +
    "sa.meta_account_id AS whatsapp_sender_account_id " +
    "FROM contacts c " +
    "LEFT JOIN whatsapp_sender_conversations sc ON sc.contact_id = c.id AND sc.state = 'bound' " +
    "LEFT JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id " +
    "WHERE c.id = $1" : "SELECT * FROM contacts WHERE id = $1", [id]
  );
  const contact = result.rows[0] || null;
  // After primary sender adoption, a feature-flag rollback must still
  // return the VERIFIED sender identity. A bare sender ID with no key is
  // indistinguishable from the secondary sender to outbound routing.
  if (contact?.whatsapp_sender_id != null && !contact.whatsapp_sender_key) {
    const owner = await pool.query(
      "SELECT sender_key,display_name,meta_phone_number_id,meta_account_id,state " +
      "FROM whatsapp_sender_accounts WHERE id=$1",
      [contact.whatsapp_sender_id]
    );
    if (owner.rows?.length !== 1 ||
        !["active", "disabled"].includes(owner.rows[0].state)) {
      throw new Error("Cannot verify persisted WhatsApp contact sender identity.");
    }
    contact.whatsapp_sender_key = owner.rows[0].sender_key;
    contact.whatsapp_sender_display_name = owner.rows[0].display_name;
    contact.whatsapp_sender_phone_number_id = owner.rows[0].meta_phone_number_id;
    contact.whatsapp_sender_account_id = owner.rows[0].meta_account_id;
    contact.whatsapp_sender_state = owner.rows[0].state;
  }
  return contact;
}

// Fail closed for optional automatic images. An unresolved clinical question
// must block sales/result graphics even when another workflow has cleared the
// contact-level attention flag. Staff takeover always blocks auto media.
// Evidence for a clinical review and a short invitation sequence is separate
// from the AI context, because outbound messages may have newer database IDs
// than the incoming message saved during a concurrent typing burst.
async function getTcmReviewEvidence(contactId, inboundMessageId) {
  if (!Number.isSafeInteger(Number(inboundMessageId)) || Number(inboundMessageId) < 1) return null;
  try {
    const result = await pool.query(
      `WITH resolved_boundary AS (
         SELECT COALESCE(MAX(inbound_message_id), 0) AS last_resolved_id
         FROM ai_review_items
         WHERE contact_id = $1 AND status = 'resolved'
           AND inbound_message_id < $2
       )
       SELECT
         EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = $1 AND r.status = 'pending'
             AND r.category <> 'information'
         ) AS pending_clinical_review,
         (SELECT COALESCE(JSONB_AGG(recent.content), '[]'::jsonb)
          FROM (
            SELECT m.content FROM messages m, resolved_boundary b
            WHERE m.contact_id = $1 AND m.role = 'user'
              AND m.id < $2 AND m.id > b.last_resolved_id
              AND m.created_at >= NOW() - INTERVAL '7 days'
            ORDER BY m.id DESC LIMIT 8
          ) recent) AS recent_customer_texts,
         (SELECT COALESCE(JSONB_AGG(recent.content), '[]'::jsonb)
          FROM (
            SELECT m.content FROM messages m
            WHERE m.contact_id = $1 AND m.role = 'assistant'
              AND m.sent_by_username IS NULL
              AND m.is_automated_follow_up = false
              AND m.created_at >= NOW() - INTERVAL '10 minutes'
              AND ${acceptedNormalOutboundSql("m")}
            ORDER BY m.created_at DESC, m.id DESC LIMIT 8
          ) recent) AS recent_accepted_assistant_texts`,
      [contactId, Number(inboundMessageId)]
    );
    const row = result.rows[0];
    if (!row || typeof row.pending_clinical_review !== "boolean" ||
        !Array.isArray(row.recent_customer_texts) ||
        !Array.isArray(row.recent_accepted_assistant_texts)) return null;
    return {
      pendingClinicalReview: row.pending_clinical_review,
      recentCustomerTexts: row.recent_customer_texts,
      recentAcceptedAssistantTexts: row.recent_accepted_assistant_texts,
    };
  } catch (error) {
    console.error("Failed to verify TCM reply evidence:", error);
    return null;
  }
}

// Distinguish a pending clinical review from an unrelated Inbox warning.
// An unavailable lookup must not authorize a normal sales reply.
async function hasPendingClinicalAiReview(id) {
  try {
    const result = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM ai_review_items
         WHERE contact_id = $1 AND status = 'pending'
           AND category <> 'information'
       ) AS pending`,
      [id]
    );
    return result.rows[0]?.pending === true;
  } catch (error) {
    console.error(`Unable to verify clinical review for contact ${id}:`, error);
    return null;
  }
}

async function canSendAutomaticReviewMedia(id) {
  try {
    const result = await pool.query(
      `SELECT (
         c.mode = 'ai'
         AND (
           c.needs_attention = false OR (
             c.needs_attention = true
             AND c.attention_reason LIKE 'AI review requested:%'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = c.id
             AND r.status = 'pending'
             AND r.category <> 'information'
         )
       ) AS allowed
       FROM contacts c WHERE c.id = $1`,
      [id]
    );
    return result.rows[0]?.allowed === true;
  } catch (err) {
    console.error(`Unable to verify automatic media review safety for contact ${id}:`, err);
    return false;
  }
}

async function updateContactName(id, name) {
  const result = await pool.query(
    "UPDATE contacts SET name = $1, updated_at = now() WHERE id = $2 RETURNING *",
    [name || null, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}


// The paged Contacts directory avoids transporting every contact and its
// message aggregates to Render on every UI refresh. Existing exports retain
// their independent full-result query and server-side access rules.
async function listContactsPage({
  search = "", assignment = "all", currentUsername = "",
  offset = 0, limit = 60, includeOwners = false,
  accessibleContactIds = null,
} = {}) {
  if (accessibleContactIds !== null &&
      (!Array.isArray(accessibleContactIds) ||
        accessibleContactIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
    throw new TypeError("Invalid contact access scope.");
  }
  if (accessibleContactIds?.length === 0) {
    return { items: [], total: 0, nextOffset: 0, hasMore: false, ownerOptions: [] };
  }
  const term = String(search || "").trim().slice(0, 100);
  const allowedAssignment = assignment === "all" || assignment === "mine" ||
    assignment === "unassigned" || (assignment.startsWith("owner:") && assignment.length > 6 && assignment.length <= 134);
  if (!allowedAssignment) throw new TypeError("Invalid contact assignment filter.");
  const start = Number(offset);
  const pageSize = Number(limit);
  if (!Number.isSafeInteger(start) || start < 0 || start > 100000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError("Invalid contacts page.");
  }
  const sql = `
    WITH matched AS (
      SELECT c.id, c.created_at, latest.created_at AS last_message_at,
        lead.id AS lead_id, lead.owner_username,
        COUNT(*) OVER()::int AS total
      FROM contacts c
      LEFT JOIN LATERAL (
        SELECT l.id, l.owner_username FROM leads l
        WHERE l.contact_id = c.id
        ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC LIMIT 1
      ) lead ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.created_at FROM messages m
        WHERE m.contact_id = c.id
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) latest ON TRUE
      WHERE ($1::text = '' OR c.name ILIKE $2
        OR c.whatsapp_profile_name ILIKE $2
        OR c.whatsapp_number ILIKE $2
        OR c.channel_user_id ILIKE $2
)
        AND ($7::integer[] IS NULL OR c.id = ANY($7::integer[]))
        AND ($3::text = 'all'
          OR ($3 = 'mine' AND lead.owner_username = $4)
          OR ($3 = 'unassigned' AND lead.owner_username IS NULL)
          OR ($3 LIKE 'owner:%'
            AND lead.owner_username = SUBSTRING($3 FROM 7)))
    ), page AS (
      SELECT * FROM matched
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT $5 OFFSET $6
    )
    SELECT
      c.id, c.whatsapp_number, c.name, c.whatsapp_profile_name,
      c.mode, c.needs_attention, c.is_unread, c.needs_follow_up,
      c.created_at, c.updated_at, c.whatsapp_opt_in_at,
      c.whatsapp_opt_in_source, c.whatsapp_opt_out_at,
      c.whatsapp_opt_out_source, c.whatsapp_marketing_opt_out_at,
      c.whatsapp_marketing_opt_out_source, c.channel, c.channel_user_id,
      c.photo_url, page.lead_id,
      page.owner_username AS lead_owner_username,
      COALESCE(lead_owner.display_name, page.owner_username)
        AS lead_owner_display_name,
      page.last_message_at, page.total,
      msg_count.message_count, inbound.latest_inbound_at
    FROM page JOIN contacts c ON c.id = page.id
    LEFT JOIN users lead_owner ON lead_owner.username = page.owner_username
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS message_count FROM messages m
      WHERE m.contact_id = c.id
    ) msg_count ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(m.source_created_at, m.created_at) AS latest_inbound_at
      FROM messages m WHERE m.contact_id = c.id AND m.role = 'user'
      ORDER BY COALESCE(m.source_created_at, m.created_at) DESC, m.id DESC LIMIT 1
    ) inbound ON TRUE
    ORDER BY page.last_message_at DESC NULLS LAST, page.created_at DESC, c.id DESC
  `;
  const result = await pool.query(sql, [
    term, `%${term}%`, assignment, String(currentUsername || ""), pageSize, start,
    accessibleContactIds,
  ]);
  const total = Number(result.rows[0]?.total || 0);
  const rows = result.rows.map(({ total: ignored, ...row }) => row);
  const items = (await hydrateSocialContactRows(rows)).map(presentPortalContact);
  let ownerOptions = null;
  if (includeOwners) {
    // Only usernames/labels are returned; the list never includes contacts
    // or message contents and stays independent of the current page.
    if (accessibleContactIds === null) {
      const owners = await pool.query(`
        SELECT DISTINCT l.owner_username AS lead_owner_username,
          COALESCE(u.display_name, l.owner_username) AS lead_owner_display_name
        FROM leads l LEFT JOIN users u ON u.username = l.owner_username
        WHERE l.owner_username IS NOT NULL
        ORDER BY lead_owner_username, lead_owner_display_name LIMIT 100
      `);
      ownerOptions = owners.rows;
    } else {
      // Restricted staff never receive assignment labels from other users.
      ownerOptions = items.filter(item => item.lead_owner_username === currentUsername)
        .slice(0, 1).map(item => ({
          lead_owner_username: item.lead_owner_username,
          lead_owner_display_name: item.lead_owner_display_name,
        }));
    }
  }
  return {
    items, total, nextOffset: start + items.length,
    hasMore: start + items.length < total, ownerOptions,
  };
}

async function listContacts(search) {
  const term = (search || "").trim();
  const params = term ? [`%${term}%`] : [];
  const result = await pool.query(
    `
    SELECT
      c.id, c.whatsapp_number, c.name, c.whatsapp_profile_name, c.mode, c.needs_attention,
      c.is_unread, c.needs_follow_up, c.created_at, c.updated_at,
      c.whatsapp_opt_in_at, c.whatsapp_opt_in_source,
      c.whatsapp_opt_out_at, c.whatsapp_opt_out_source,
      c.whatsapp_marketing_opt_out_at, c.whatsapp_marketing_opt_out_source,
      c.channel, c.channel_user_id, c.photo_url,
      current_lead.id AS lead_id,
      current_lead.owner_username AS lead_owner_username,
      COALESCE(lead_owner.display_name, current_lead.owner_username) AS lead_owner_display_name,
      COUNT(m.id)::int AS message_count,
      MAX(m.created_at) AS last_message_at,
      MAX(COALESCE(m.source_created_at, m.created_at))
        FILTER (WHERE m.role = 'user') AS latest_inbound_at
    FROM contacts c
    LEFT JOIN LATERAL (
      SELECT l.id, l.owner_username
      FROM leads l
      WHERE l.contact_id = c.id
      ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC
      LIMIT 1
    ) current_lead ON true
    LEFT JOIN users lead_owner ON lead_owner.username = current_lead.owner_username
    LEFT JOIN messages m ON m.contact_id = c.id
    ${term ? "WHERE c.name ILIKE $1 OR c.whatsapp_profile_name ILIKE $1 OR c.whatsapp_number ILIKE $1 OR c.channel_user_id ILIKE $1" : ""}
    GROUP BY c.id, current_lead.id, current_lead.owner_username, lead_owner.display_name
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
    "UPDATE contacts SET name = $1, whatsapp_number = $2, updated_at = now() " +
    "WHERE id = $3 AND NOT EXISTS (" +
    "SELECT 1 FROM whatsapp_sender_conversations sc " +
    "WHERE sc.contact_id = $3 AND sc.customer_wa_id <> $2" +
    ") RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber), id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

// Search the full customer directory without fetching historical chats or
// triggering Meta profile lookups. Consumers must apply server-side ownership
// restrictions; this does not grant send permission or bypass sender isolation.
async function searchConversationDirectory({ term, accessibleContactIds = null, limit = 40 } = {}) {
  const text = String(term || "").trim().slice(0, 80);
  if (text.length < 2 || accessibleContactIds?.length === 0) return [];
  const escaped = text.replace(/[\\%_]/g, "\\$&");
  const normalizedPhone = text.replace(/[^0-9]/g, "");
  const boundLimit = Math.max(1, Math.min(60, Number(limit) || 40));
  const result = await pool.query(`
    SELECT c.id AS contact_id, c.id, c.name, c.whatsapp_profile_name,
           c.whatsapp_number, c.channel, c.photo_url, c.mode,
           c.whatsapp_sender_id,
           sa.sender_key AS whatsapp_sender_key,
           sa.display_name AS whatsapp_sender_display_name,
           sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
           sa.meta_account_id AS whatsapp_sender_account_id,
           sa.state AS whatsapp_sender_state,
           sa.coexistence_enabled AS whatsapp_sender_coexistence_enabled,
           c.needs_attention, c.is_unread, c.needs_follow_up,
           current_lead.treatment_interest AS treatment_interest,
           c.created_at
    FROM contacts c
    LEFT JOIN whatsapp_sender_conversations sc
      ON sc.contact_id = c.id AND sc.state = 'bound'
    LEFT JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id
    LEFT JOIN LATERAL (
      SELECT l.treatment_interest FROM leads l WHERE l.contact_id = c.id
      ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC LIMIT 1
    ) current_lead ON TRUE
    WHERE ($2::integer[] IS NULL OR c.id = ANY($2::integer[]))
      AND (
        c.name ILIKE $1 OR c.whatsapp_profile_name ILIKE $1
        OR c.whatsapp_number ILIKE $1
        OR ($4::text <> '' AND c.whatsapp_number ILIKE $4)
      )
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT $3`,
    [`%${escaped}%`, accessibleContactIds, boundLimit,
     normalizedPhone.length >= 2 ? `%${normalizedPhone}%` : ""]
  );
  const resolveTreatment = createInboxTreatmentResolver();
  return result.rows.map(row => ({
    ...presentPortalContact(row),
    treatment_filter_key: resolveTreatment(row.treatment_interest).key,
  }));
}

async function listConversations({
  contactId = null, includeEmptyCoexistenceContacts = false,
  accessibleContactIds = null, contactIds = null,
} = {}) {
  // Restrict large Inbox reads inside PostgreSQL, before thousands of joins
  // and message/review columns leave Neon. The route still verifies current
  // staff permission after the query, before returning any row to the browser.
  if (accessibleContactIds !== null && !Array.isArray(accessibleContactIds)) {
    throw new TypeError("Inbox access scope must be null or a contact ID array");
  }
  if (accessibleContactIds?.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TypeError("Inbox access scope contains an invalid contact ID");
  }
  if (accessibleContactIds?.length === 0) return [];
  if (contactIds !== null &&
      (!Array.isArray(contactIds) ||
        contactIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
    throw new TypeError("Invalid Inbox page contact IDs");
  }
  if (contactIds?.length === 0) return [];
  const scopedFilter = accessibleContactIds === null ? ""
    : "c.id = ANY($" + (contactId == null ? 1 : 2) + "::integer[]) AND ";
  const scopedWhere = accessibleContactIds === null ? ""
    : "AND c.id = ANY($" + (contactId == null ? 1 : 2) + "::integer[])";
  const scopedParams = [
    ...(contactId == null ? [] : [contactId]),
    ...(accessibleContactIds === null ? [] : [accessibleContactIds]),
    ...(contactIds === null ? [] : [contactIds]),
  ];
  const pageParam = scopedParams.length;
  const pageFilter = contactIds === null ? "" :
    "c.id = ANY($" + pageParam + "::integer[]) AND ";
  const pageWhere = contactIds === null ? "" :
    "AND c.id = ANY($" + pageParam + "::integer[])";
  // Inbox hides untouched contact-only Coexistence address-book imports; Contacts
  // retains them, and genuine history/live threads remain visible. This is a
  // read filter, never a delete or a change to sender routing/follow-up policy.
  // Coexistence can import thousands of address-book contacts that have no
  // messages or lead activity. Keep them searchable in Contacts, but do not
  // hydrate them on every Inbox refresh. Explicit "false" restores the old list.
  // Archived direct links still require the existing explicit archive option.
  const hideEmptyCoexistence = senderAwareInboxReadsEnabled() &&
    !includeEmptyCoexistenceContacts &&
    process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS !== "false";
  // Preselect eligible IDs before expensive lead/message review subqueries.
  const candidatesSql = hideEmptyCoexistence ? `
    WITH eligible_inbox_contacts AS MATERIALIZED (
      SELECT c.id FROM contacts c
      WHERE ${contactId == null ? "" : "c.id = $1 AND "}${scopedFilter}${pageFilter}NOT (
        c.whatsapp_sender_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM whatsapp_sender_accounts account
          WHERE account.id = c.whatsapp_sender_id
            AND account.coexistence_enabled = TRUE
        )
        AND NOT EXISTS (SELECT 1 FROM messages any_message WHERE any_message.contact_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM leads existing_lead WHERE existing_lead.contact_id = c.id)
        AND c.is_unread IS DISTINCT FROM TRUE
        AND c.needs_attention IS DISTINCT FROM TRUE
        AND c.needs_follow_up IS DISTINCT FROM TRUE
        AND c.mode IS DISTINCT FROM 'human'
      )
    )` : "";
  const result = await pool.query(
    `
    ${candidatesSql}
    ${hideEmptyCoexistence ? "," : "WITH"} pending_ai_review_rows AS MATERIALIZED (
      SELECT r.contact_id, r.id, r.inbound_message_id, r.summary, r.category,
             r.created_at,
             ROW_NUMBER() OVER (
               PARTITION BY r.contact_id ORDER BY r.created_at DESC, r.id DESC
             ) AS review_rank
      FROM ai_review_items r
      WHERE r.status = 'pending'
      ${hideEmptyCoexistence ? "AND EXISTS (SELECT 1 FROM eligible_inbox_contacts eligible WHERE eligible.id = r.contact_id)" : ""}
    ), pending_ai_reviews AS MATERIALIZED (
      SELECT r.contact_id,
             COUNT(*)::integer AS pending_review_count,
             STRING_AGG(
               '[#' || r.inbound_message_id::text || '] ' || LEFT(r.summary, 200),
               CHR(10) ORDER BY r.created_at, r.id
             ) FILTER (WHERE r.review_rank <= 10) AS pending_review_summaries,
             COALESCE(
               JSONB_AGG(
                 JSONB_BUILD_OBJECT(
                   'id', r.id, 'messageId', r.inbound_message_id,
                   'summary', r.summary, 'category', r.category
                 ) ORDER BY r.created_at, r.id
               ) FILTER (WHERE r.review_rank <= 25),
               '[]'::jsonb
             ) AS pending_review_items
      FROM pending_ai_review_rows r
      GROUP BY r.contact_id
    )
    SELECT
      c.id AS contact_id,
      c.whatsapp_number,
      c.name,
      c.whatsapp_profile_name,
      c.channel,
      c.channel_user_id,
      c.photo_url,
${senderAwareInboxReadsEnabled() ? `
      c.whatsapp_sender_id,
      sa.sender_key AS whatsapp_sender_key,
      sa.display_name AS whatsapp_sender_display_name,
      sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
      sa.meta_account_id AS whatsapp_sender_account_id,
      sa.state AS whatsapp_sender_state,
      sa.coexistence_enabled AS whatsapp_sender_coexistence_enabled,
      ` : ""}
      c.mode,
      c.takeover_by,
      c.takeover_at,
      c.updated_at,
      c.created_at,
      c.needs_attention,
      c.attention_reason,
      ${senderAwareInboxReadsEnabled() ? `
      CASE
        WHEN sa.sender_key='neutro_secondary'
          AND c.updated_at >= NOW()-INTERVAL '14 days'
          AND EXISTS (
            SELECT 1 FROM messages unsupported
            JOIN whatsapp_sender_message_context source_context
              ON source_context.message_id=unsupported.id
            JOIN whatsapp_sender_conversations source_conversation
              ON source_conversation.id=source_context.conversation_id
             AND source_conversation.sender_id=c.whatsapp_sender_id
             AND source_conversation.contact_id=c.id
             AND source_conversation.customer_wa_id=c.whatsapp_number
             AND source_conversation.state='bound'
            WHERE unsupported.contact_id=c.id
              AND unsupported.role='user'
              AND unsupported.source_created_at >= NOW()-INTERVAL '14 days'
              AND unsupported.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
              AND NOT EXISTS (
                SELECT 1 FROM whatsapp_sender_coexistence_history_messages historical
                WHERE historical.message_id=unsupported.id
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM whatsapp_free_entry_referrals identified_ad
            WHERE identified_ad.contact_id=c.id
              AND identified_ad.source_type='ad'
              AND (NULLIF(BTRIM(identified_ad.meta_ad_id),'') IS NOT NULL
                   OR NULLIF(BTRIM(identified_ad.ctwa_clid),'') IS NOT NULL)
          )
        THEN CASE WHEN EXISTS (
          SELECT 1 FROM inbound_processing_jobs confirmed_error
          JOIN messages confirmed_message ON confirmed_message.id=confirmed_error.message_id
          JOIN whatsapp_sender_message_context confirmed_context
            ON confirmed_context.message_id=confirmed_message.id
          JOIN whatsapp_sender_conversations confirmed_conversation
            ON confirmed_conversation.id=confirmed_context.conversation_id
           AND confirmed_conversation.sender_id=c.whatsapp_sender_id
           AND confirmed_conversation.contact_id=c.id
           AND confirmed_conversation.customer_wa_id=c.whatsapp_number
           AND confirmed_conversation.state='bound'
          WHERE confirmed_error.contact_id=c.id
            AND confirmed_error.channel='whatsapp'
            AND confirmed_message.contact_id=c.id
            AND confirmed_message.role='user'
            AND confirmed_message.source_created_at >= NOW()-INTERVAL '14 days'
            AND confirmed_message.content LIKE '📎 [% sent a WhatsApp message that could not be displayed]'
            AND confirmed_error.incoming_payload->>'unsupportedType'='unsupported'
            AND confirmed_error.incoming_payload->'unsupportedErrors'
                @> '[{"code":131060}]'::jsonb
            AND NOT EXISTS (
              SELECT 1 FROM whatsapp_sender_coexistence_history_messages historical
              WHERE historical.message_id=confirmed_message.id
            )
        ) THEN 'meta_131060_unverified'
          -- The processing evidence may have expired or been pruned.
          ELSE 'unreadable_origin_unverified'
        END
        ELSE NULL
      END AS whatsapp_ad_evidence_status,
      ` : "NULL::text AS whatsapp_ad_evidence_status,"}
      COALESCE(pending_reviews.pending_review_count, 0) AS pending_review_count,
      pending_reviews.pending_review_summaries,
      COALESCE(pending_reviews.pending_review_items, '[]'::jsonb) AS pending_review_items,
      c.is_unread,
      c.needs_follow_up,
      c.inbox_archived_at,
      c.whatsapp_opt_in_at,
      c.whatsapp_opt_in_source,
      c.whatsapp_opt_out_at,
      c.whatsapp_opt_out_source,
      c.whatsapp_marketing_opt_out_at,
      c.whatsapp_marketing_opt_out_source,
      current_lead.id AS lead_id,
      CASE WHEN current_lead.is_closed = false THEN current_lead.temperature ELSE NULL END AS lead_temperature,
      current_lead.owner_username AS lead_owner_username,
      current_lead.treatment_interest AS treatment_interest,
      COALESCE(lead_owner.display_name, current_lead.owner_username) AS lead_owner_display_name,
      m.content AS last_message,
      m.role AS last_message_role,
      m.media_url AS last_message_media_url,
      m.created_at AS last_message_at,
      latest_customer.latest_inbound_at AS latest_inbound_at,
      (last_inbound_for_reply.id IS NOT NULL AND (
        last_accepted_reply.id IS NULL
        OR (last_accepted_reply.created_at, last_accepted_reply.id)
           <= (last_inbound_for_reply.created_at, last_inbound_for_reply.id)
      )) AS has_unreplied
    FROM ${hideEmptyCoexistence
      ? "eligible_inbox_contacts eligible JOIN contacts c ON c.id = eligible.id"
      : "contacts c"}
${senderAwareInboxReadsEnabled() ? `
    LEFT JOIN whatsapp_sender_conversations sc
      ON sc.contact_id = c.id AND sc.state = 'bound'
    LEFT JOIN whatsapp_sender_accounts sa ON sa.id = sc.sender_id
    ` : ""}
    LEFT JOIN pending_ai_reviews pending_reviews
      ON pending_reviews.contact_id = c.id
    LEFT JOIN LATERAL (
      SELECT l.id, l.owner_username, l.treatment_interest, l.temperature, l.is_closed
      FROM leads l
      WHERE l.contact_id = c.id
      ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC
      LIMIT 1
    ) current_lead ON true
    LEFT JOIN users lead_owner ON lead_owner.username = current_lead.owner_username
    LEFT JOIN LATERAL (
      SELECT content, role, media_url, created_at
      FROM messages
      WHERE contact_id = c.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(source_created_at, created_at) AS latest_inbound_at
      FROM messages
      WHERE contact_id = c.id AND role = 'user'
      ORDER BY COALESCE(source_created_at, created_at) DESC, id DESC
      LIMIT 1
    ) latest_customer ON true
    -- Any unanswered inbound exists iff the newest inbound is later than the
    -- newest provider-accepted outbound. Keep the original (created_at,id)
    -- ordering, independent of the source timestamp shown in the Inbox.
    LEFT JOIN LATERAL (
      SELECT inbound.id, inbound.created_at
      FROM messages inbound
      WHERE inbound.contact_id = c.id AND inbound.role = 'user'
      ORDER BY inbound.created_at DESC, inbound.id DESC
      LIMIT 1
    ) last_inbound_for_reply ON true
    LEFT JOIN LATERAL (
      SELECT outbound.id, outbound.created_at
      FROM messages outbound
      WHERE outbound.contact_id = c.id
        AND outbound.role = 'assistant'
        -- Unsigned drafts and failed/unknown sends are not accepted replies.
        AND ${acceptedNormalOutboundSql("outbound")}
      ORDER BY outbound.created_at DESC, outbound.id DESC
      LIMIT 1
    ) last_accepted_reply ON last_inbound_for_reply.id IS NOT NULL
    WHERE (m.created_at IS NOT NULL OR c.channel = 'whatsapp')
     ${contactId == null ? "" : "AND c.id = $1"} ${scopedWhere} ${pageWhere}
    ORDER BY c.needs_attention DESC, m.created_at DESC NULLS LAST, c.created_at DESC
    `,
    scopedParams
  );
  const hydrated = await hydrateSocialContactRows(result.rows);
  const resolveTreatment = createInboxTreatmentResolver();
  return hydrated.map(row => ({
    ...presentPortalContact(row),
    treatment_filter_key: resolveTreatment(row.treatment_interest).key,
  }));
}

async function takeOver(id, staffUsername) {
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $2::integer)
     ), current_contact AS MATERIALIZED (
       SELECT c.id
       FROM contacts c, conversation_lock
       WHERE c.id = $2
     ), latest_inbound AS (
       SELECT inbound.id, inbound.created_at
       FROM messages inbound, current_contact
       WHERE inbound.contact_id = current_contact.id
         AND inbound.role = 'user'
       ORDER BY inbound.created_at DESC, inbound.id DESC
       LIMIT 1
     ), anchor AS (
       SELECT outbound.id
       FROM messages outbound, current_contact, latest_inbound
       WHERE outbound.contact_id = current_contact.id
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
         current_contact.id,
         anchor.id,
         1,
         'skip',
         'Cancelled because clinic staff took over this conversation.',
         NULL
       FROM current_contact, anchor
       ON CONFLICT (trigger_message_id, follow_up_step) DO UPDATE
          SET reason = EXCLUDED.reason,
              topic = NULL,
              created_at = now()
          WHERE follow_up_ai_decisions.action = 'skip'
       RETURNING id
     ), takeover AS (
       UPDATE contacts c
       SET mode = 'human', takeover_by = $1, takeover_at = now(),
           -- Taking ownership is not resolving a failed or unknown send.
           -- Keep existing delivery, booking, safety and clinical attention
           -- until a confirmed reply or an explicit staff resolution.
           needs_attention = c.needs_attention OR EXISTS (
             SELECT 1 FROM ai_review_items r
             WHERE r.contact_id = c.id AND r.status = 'pending'
           ),
           attention_reason = CASE
             WHEN c.needs_attention THEN COALESCE(c.attention_reason, 'Staff review required.')
             WHEN c.attention_reason LIKE 'AI review requested:%' THEN c.attention_reason
             WHEN EXISTS (
               SELECT 1 FROM ai_review_items r
               WHERE r.contact_id = c.id AND r.status = 'pending'
             ) THEN 'AI review requested: ' || COALESCE((
               SELECT STRING_AGG('[#' || r.inbound_message_id::text || '] ' ||
                 LEFT(r.summary, 200), CHR(10) ORDER BY r.created_at, r.id)
               FROM ai_review_items r
               WHERE r.contact_id = c.id AND r.status = 'pending'
             ), '')
             ELSE NULL
           END,
           is_unread = false,
           updated_at = now()
       FROM current_contact
       WHERE c.id = current_contact.id
       RETURNING c.*
     )
     SELECT takeover.*
     FROM takeover
     LEFT JOIN cancelled_sequence ON true`,
    [staffUsername, id]
  );
  const updated = result.rows[0] || null;
  // Keep the existing Telegram cooldown while staff owns the chat. Otherwise
  // the very next customer message in human mode could immediately generate a
  // second intervention alert for the same unresolved conversation.
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}


/** Admin-approved, time-limited AI access for a legacy secondary contact. */
async function approveSecondaryManualAi(id, username, expectedUpdatedAt, env = process.env, database = pool) {
  if (!secondaryLegacyStaffCutoff(env) ||
      env.WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE !== "all_contacts" ||
      env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE !== "all_contacts" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED !== "true" ||
      env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED !== "true" ||
      !env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || !env.WHATSAPP_SECONDARY_WABA_ID ||
      !username || !expectedUpdatedAt) return null;
  const result = await database.query(
    `UPDATE contacts c
     SET whatsapp_secondary_manual_ai_approved_at = now(),
         whatsapp_secondary_manual_ai_approved_until = now() + INTERVAL '7 days',
         whatsapp_secondary_manual_ai_approved_by = $4,
         updated_at = now()
     FROM whatsapp_sender_accounts sa, whatsapp_sender_conversations sc
     WHERE c.id = $1 AND c.channel = 'whatsapp'
       AND c.mode = 'ai' AND c.needs_attention IS NOT TRUE
       AND c.whatsapp_opt_out_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ai_review_items review
         WHERE review.contact_id = c.id AND review.status = 'pending'
       )
       AND (c.whatsapp_secondary_manual_ai_approved_until IS NULL
            OR c.whatsapp_secondary_manual_ai_approved_until <= now())
       AND sa.id = c.whatsapp_sender_id
       AND sa.sender_key = 'neutro_secondary'
       AND sa.state = 'active' AND sa.coexistence_enabled = TRUE
       AND sa.meta_phone_number_id = $2 AND sa.meta_account_id = $3
       AND sc.sender_id = sa.id AND sc.contact_id = c.id
       AND sc.customer_wa_id = c.whatsapp_number AND sc.state = 'bound'
       AND date_trunc('milliseconds', c.updated_at) = $5::timestamptz
     RETURNING c.*`,
    [id, env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID, env.WHATSAPP_SECONDARY_WABA_ID,
      username, expectedUpdatedAt]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

async function returnToAi(id, expectedUpdatedAt = null) {
  // An old synthetic handoff can leave the AI-owned conversation permanently
  // excluded from follow-ups. An explicit Return to AI may clear only that
  // specific handoff flag, and only after a real staff reply was accepted
  // *after* the latest customer message. It must not clear unanswered reviews
  // or unconfirmed/failed outbound sends.
  const answeredLegacyHandoff = `(
    c.attention_reason = 'AI handed off this conversation.'
    -- Do not infer resolution from a historical staff reply when there is
    -- no reliable handoff boundary (such as after a prior Return to AI).
    AND c.mode = 'human'
    AND c.takeover_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM messages staff_reply
      WHERE staff_reply.contact_id = c.id
        AND staff_reply.role = 'assistant'
        AND staff_reply.sent_by_username IS NOT NULL
        AND staff_reply.is_automated_follow_up = false
        AND NOT EXISTS (
          SELECT 1 FROM outbound_message_evidence fallback
          WHERE fallback.message_id = staff_reply.id
            AND fallback.origin = 'system_fallback'
        )
        -- Provider acceptance is enough; Meta delivery receipts can arrive
        -- later. Never infer acceptance from a draft, failed or unknown send.
        AND staff_reply.whatsapp_message_id IS NOT NULL
        AND (
          staff_reply.delivery_status IS NULL
          OR staff_reply.delivery_status IN ('pending', 'sent', 'delivered', 'read')
        )
        AND staff_reply.created_at >= c.takeover_at
        AND staff_reply.created_at > COALESCE((
          SELECT MAX(inbound.created_at) FROM messages inbound
          WHERE inbound.contact_id = c.id AND inbound.role = 'user'
        ), '-infinity'::timestamptz)
    )
    AND NOT EXISTS (
      SELECT 1 FROM ai_review_items review
      WHERE review.contact_id = c.id AND review.status = 'pending'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages blocked
      WHERE blocked.contact_id = c.id AND blocked.role = 'assistant'
        AND blocked.delivery_status IN ('failed', 'unknown')
        -- A resolved failure from an unrelated older conversation cycle must
        -- not hold a newer, staff-answered handoff hostage.
        AND blocked.created_at >= COALESCE((
          SELECT MAX(inbound.created_at) FROM messages inbound
          WHERE inbound.contact_id = c.id AND inbound.role = 'user'
        ), '-infinity'::timestamptz)
    )
  )`;
  const result = await pool.query(
    `UPDATE contacts c
     SET mode = 'ai', takeover_by = NULL, takeover_at = NULL,
         needs_attention = CASE
           WHEN ${answeredLegacyHandoff} THEN false
           ELSE c.needs_attention OR EXISTS (
             SELECT 1 FROM ai_review_items r
             WHERE r.contact_id = c.id AND r.status = 'pending'
           )
         END,
         attention_reason = CASE
           WHEN EXISTS (
             SELECT 1 FROM ai_review_items r
             WHERE r.contact_id = c.id AND r.status = 'pending'
           ) AND (
             c.attention_reason IS NULL
             OR c.attention_reason LIKE 'AI review requested:%'
           ) THEN 'AI review requested: ' || COALESCE((
             SELECT RIGHT(STRING_AGG('[#' || r.inbound_message_id::text || '] ' ||
               r.summary, CHR(10) ORDER BY r.created_at, r.id), 1600)
             FROM ai_review_items r
             WHERE r.contact_id = c.id AND r.status = 'pending'
           ), '')
           WHEN ${answeredLegacyHandoff} THEN NULL
           ELSE c.attention_reason
         END,
         updated_at = now()
     WHERE c.id = $1
       AND c.mode = 'human'
       -- Explicitly returning to AI is a staff resolution action, but an
       -- unanswered genuine handoff must stay staff-owned. Dismiss attention
       -- only after staff has actually reviewed the outstanding issue.
       AND (c.attention_reason IS DISTINCT FROM 'AI handed off this conversation.'
         OR ${answeredLegacyHandoff})
       -- Compare the browser's observed version atomically. A stale click
       -- must not overwrite a newer handoff, contact reply or staff takeover.
       AND ($2::timestamptz IS NULL
         OR date_trunc('milliseconds', c.updated_at) = $2::timestamptz)
     RETURNING c.*`,
    [id, expectedUpdatedAt]
  );
  const updated = result.rows[0] || null;
  // Human-intervention Telegram alerts use a strict rolling 30-minute
  // per-contact cooldown. Returning to AI must not reopen that window early.
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

async function clearStaffAssistStateIfUnchanged(contact) {
  if (!contact?.id || !contact?.updated_at) return null;

  const result = await pool.query(
    `UPDATE contacts
     SET needs_attention = EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = contacts.id AND r.status = 'pending'
         ) OR EXISTS (
           SELECT 1 FROM messages m
           WHERE m.contact_id = contacts.id
               AND ${unresolvedFailedOutboundSql("m", "contacts", { ignoreUnlinkedHistoricalMedia: true })}
         ) OR (
           -- A manual reply does not confirm an appointment was booked.
           -- Keep Booking Ready flagged until staff explicitly dismisses it.
           contacts.needs_attention = true
           AND COALESCE(contacts.attention_reason ILIKE 'Booking ready:%', false)
         ),
         attention_reason = CASE
           -- Booking Ready is an unresolved scheduling task; an unrelated
           -- historical delivery failure must not replace that task's reason.
           -- Failed/unknown messages remain visible in individual Inbox
           -- delivery statuses and still count towards needs_attention above.
           -- Explicit attention dismissal remains the only resolution action.
           WHEN contacts.needs_attention = true
             AND COALESCE(contacts.attention_reason ILIKE 'Booking ready:%', false)
           THEN contacts.attention_reason
           -- For all other attention reasons preserve the existing priority:
           -- delivery failures take precedence over AI review summaries.
           WHEN EXISTS (
             SELECT 1 FROM messages m
             WHERE m.contact_id = contacts.id
               AND ${unresolvedFailedOutboundSql("m", "contacts", { ignoreUnlinkedHistoricalMedia: true })}
           ) THEN CASE
             WHEN attention_reason LIKE 'Delivery failed:%'
               OR attention_reason LIKE 'Delivery unconfirmed:%'
             THEN attention_reason
             ELSE 'Delivery failed: One or more outbound messages need staff review.'
           END
           WHEN EXISTS (
             SELECT 1 FROM ai_review_items r
             WHERE r.contact_id = contacts.id AND r.status = 'pending'
           ) THEN CASE
             WHEN attention_reason LIKE 'AI review requested:%' THEN attention_reason
             ELSE 'AI review requested: ' || COALESCE((
               SELECT STRING_AGG('[#' || r.inbound_message_id::text || '] ' ||
                        LEFT(r.summary, 200), CHR(10) ORDER BY r.created_at, r.id)
               FROM ai_review_items r
               WHERE r.contact_id = contacts.id AND r.status = 'pending'
             ), '')
           END
           ELSE NULL
         END,
         delivery_attention_message_id = CASE
           WHEN EXISTS (
             SELECT 1 FROM messages m
             WHERE m.contact_id = contacts.id
               AND ${unresolvedFailedOutboundSql("m", "contacts", { ignoreUnlinkedHistoricalMedia: true })}
           ) THEN (
             SELECT m.id FROM messages m
             WHERE m.contact_id = contacts.id
               AND ${unresolvedFailedOutboundSql("m", "contacts", { ignoreUnlinkedHistoricalMedia: true })}
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1
           )
           ELSE NULL
         END,
         is_unread = false,
         updated_at = now()
     WHERE id = $1
       -- node-postgres parses timestamps to millisecond-precision JS Dates,
       -- whereas now() persists microseconds. Match the same 1ms bucket
       -- without allowing a newer changed attention/mode/unread snapshot.
       AND date_trunc('milliseconds', updated_at) = $2::timestamptz
       AND mode = $3
       AND takeover_by IS NOT DISTINCT FROM $4
       AND needs_attention = $5
       AND attention_reason IS NOT DISTINCT FROM $6
       AND is_unread = $7
       -- A saved draft is not proof that the patient has been answered.
       -- Preserve genuine handoffs until staff deliberately resolves them;
       -- informational AI reviews retain the existing separate review logic.
       AND attention_reason IS DISTINCT FROM 'AI handed off this conversation.'
       AND NOT (
         mode = 'human' AND needs_attention = true
         AND attention_reason IS NOT NULL
         AND attention_reason NOT LIKE 'AI review requested:%'
       )
     RETURNING *`,
    [
      contact.id,
      contact.updated_at,
      contact.mode,
      contact.takeover_by ?? null,
      contact.needs_attention === true,
      contact.attention_reason ?? null,
      contact.is_unread === true,
    ]
  );

  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact });
  return updated;
}

async function setAttention(
  id,
  needsAttention,
  reason = null,
  { notifyWebPush: shouldNotifyWebPush = true } = {}
) {
  const result = await pool.query(
    `UPDATE contacts c
     SET needs_attention = $1, attention_reason = $2,
         -- A different staff/clinical reason must not inherit a former
         -- delivery attempt's message anchor.
         delivery_attention_message_id = NULL,
         updated_at = now()
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
    publishContactChange(updated.id, { contact: updated });
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
      if (shouldNotifyWebPush) {
        notifyWebPush(updated.id, "human_intervention");
      }
    }
  }
  return updated;
}

// Every unresolved question gets one durable row keyed by its inbound message.
// Keep the contact AI-owned. Concurrent duplicate webhook jobs cannot create
// duplicate questions or trigger another staff alert.
async function setAiReviewAttention(id, inboundMessageId, summary, category = "clinical") {
  if (!Number.isSafeInteger(Number(inboundMessageId)) || Number(inboundMessageId) < 1) {
    throw new Error("AI review requires the original inbound message ID.");
  }
  const safeSummary = String(summary || "Unanswered customer question").trim().slice(0, 350);
  const safeCategory = category === "information" ? "information" : "clinical";
  // Group same-worded pending clinical questions, plus recognised variations
  // of one high-confidence symptom. Other/new concerns and informational
  // reviews still generate independent alerts.
  // No schema change: compare the existing pending message summaries.
  const urinaryReviewTopic = safeCategory === "clinical" &&
    /(?:漏尿|尿失禁|尿漏|漏小便|憋不住尿|urinary\s+(?:leakage|incontinence)|urine\s+leak|leak(?:ing|age)?\s+urine|kencing\s+(?:bocor|tak\s+tahan)|tak\s+tahan\s+kencing)/iu.test(safeSummary);
  const existingConcernPattern = urinaryReviewTopic
    ? "(漏尿|尿失禁|尿漏|漏小便|憋不住尿|urinary[[:space:]]+(leakage|incontinence)|urine[[:space:]]+leak|leak(ing|age)?[[:space:]]+urine|kencing[[:space:]]+(bocor|tak[[:space:]]+tahan)|tak[[:space:]]+tahan[[:space:]]+kencing)"
    : null;
  const result = await pool.query(
    `WITH eligible AS MATERIALIZED (
       SELECT c.id FROM contacts c
       WHERE c.id = $1 AND c.mode = 'ai'
       FOR UPDATE
     ), previous_same_concern AS MATERIALIZED (
       SELECT EXISTS (
         SELECT 1 FROM eligible e
         JOIN ai_review_items earlier ON earlier.contact_id = e.id
         WHERE earlier.status = 'pending'
           AND earlier.category = 'clinical'
           AND (
             ($5::text IS NOT NULL AND earlier.summary ~* $5::text)
             OR ($5::text IS NULL AND
               lower(btrim(earlier.summary)) = lower(btrim($3::text)))
           )
       ) AS already_pending
     ), inserted AS (
       INSERT INTO ai_review_items (contact_id, inbound_message_id, summary, category)
       SELECT eligible.id, m.id, $3, $4
       FROM eligible
       JOIN messages m ON m.contact_id = eligible.id
         AND m.id = $2 AND m.role = 'user'
       ON CONFLICT (contact_id, inbound_message_id) DO NOTHING
       RETURNING id, contact_id, inbound_message_id
     ), updated AS (
       UPDATE contacts c SET
         needs_attention = true,
         attention_reason = CASE
           WHEN c.needs_attention = true
             AND c.attention_reason NOT LIKE 'AI review requested:%'
           THEN c.attention_reason
           WHEN c.attention_reason LIKE 'AI review requested:%'
           THEN 'AI review requested: ' ||
             RIGHT(COALESCE(SUBSTRING(c.attention_reason FROM
                 CHAR_LENGTH('AI review requested: ') + 1), '') ||
               CHR(10) || '[#' || $2::text || '] ' || $3, 1600)
           ELSE 'AI review requested: [#' || $2::text || '] ' || $3
         END,
         updated_at = now()
       FROM inserted
       WHERE c.id = inserted.contact_id
       RETURNING c.*
     )
     SELECT updated.*, inserted.id AS ai_review_id,
            inserted.inbound_message_id AS attention_message_id,
            NOT previous_same_concern.already_pending AS notify_ai_review
     FROM updated JOIN inserted ON inserted.contact_id = updated.id
     CROSS JOIN previous_same_concern`,
    [id, Number(inboundMessageId), safeSummary, safeCategory, existingConcernPattern]
  );
  const updated = result.rows[0] || null;
  if (!updated) return getContactById(id);
  const notifyStaff = updated.notify_ai_review !== false;
  delete updated.notify_ai_review;
  publishContactChange(updated.id, { contact: updated });
  // A new message always creates its own Inbox review row, but a repeated
  // urinary-leakage concern already pending does not create another alert.
  if (notifyStaff) {
    notifyTelegram(
      telegramImmediateAlerts.sendAiReviewAlert({
      contactId: updated.id,
      messageId: updated.attention_message_id,
      reason: `AI review requested: [#${inboundMessageId}] ${safeSummary}`,
    }),
    "AI review",
    updated.id
  );
    notifyWebPush(updated.id, "ai_review");
  }
  return updated;
}

// Explicit Inbox dismissal resolves all pending question records and their
// Attention indicator as one serialized operation. Future incoming questions
// can create fresh reviews; no other staff send implicitly clears them.
async function dismissAttentionAndReviews(id) {
  const result = await pool.query(
    `WITH locked AS MATERIALIZED (
       SELECT id FROM contacts WHERE id = $1 FOR UPDATE
     ), resolved AS (
       UPDATE ai_review_items r
       SET status = 'resolved', resolved_at = now()
       FROM locked WHERE r.contact_id = locked.id AND r.status = 'pending'
       RETURNING r.id
     ), cleared AS (
       UPDATE contacts c
       SET needs_attention = CASE
             WHEN NOT EXISTS (SELECT 1 FROM resolved) THEN false
             WHEN c.needs_attention = true
               AND (c.attention_reason IS NULL
                 OR c.attention_reason NOT LIKE 'AI review requested:%')
             THEN true
             WHEN EXISTS (
               SELECT 1 FROM messages m
               WHERE m.contact_id = c.id
                  AND ${unresolvedFailedOutboundSql("m", "c")}
             ) THEN true
             ELSE false
           END,
           attention_reason = CASE
             WHEN NOT EXISTS (SELECT 1 FROM resolved) THEN NULL
             WHEN c.needs_attention = true
               AND (c.attention_reason IS NULL
                 OR c.attention_reason NOT LIKE 'AI review requested:%')
             THEN c.attention_reason
             WHEN EXISTS (
               SELECT 1 FROM messages m
               WHERE m.contact_id = c.id
                  AND ${unresolvedFailedOutboundSql("m", "c")}
             ) THEN 'Delivery failed: One or more outbound messages need staff review.'
             ELSE NULL
           END,
           delivery_attention_dismissed_at = CASE
             -- Only an explicit attention dismissal acknowledges failed
             -- media; regular staff sends must never do so implicitly.
             WHEN NOT EXISTS (SELECT 1 FROM resolved)
               AND (
                 c.attention_reason LIKE 'Delivery failed:%'
                 OR c.attention_reason LIKE 'Delivery unconfirmed:%'
                 OR c.attention_reason = 'New message — conversation is staff-owned.'
               )
             THEN clock_timestamp()
             ELSE c.delivery_attention_dismissed_at
           END,
           delivery_attention_message_id = CASE
             WHEN NOT EXISTS (SELECT 1 FROM resolved)
               AND (
                 c.attention_reason LIKE 'Delivery failed:%'
                 OR c.attention_reason LIKE 'Delivery unconfirmed:%'
                 OR c.attention_reason = 'New message — conversation is staff-owned.'
               )
             THEN NULL
             ELSE c.delivery_attention_message_id
           END,
           updated_at = now()
       FROM locked WHERE c.id = locked.id
       RETURNING c.*
     )
     SELECT cleared.* FROM cleared`,
    [id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

// Resolve one review only. The contact row lock serializes staff dismissal
// with new review inserts, and the remaining count excludes the just-resolved
// item because data-modifying CTEs share one statement snapshot.
async function resolveAiReviewItem(contactId, reviewId) {
  const result = await pool.query(
    `WITH locked AS MATERIALIZED (
       SELECT id FROM contacts WHERE id = $1 FOR UPDATE
     ), resolved AS (
       UPDATE ai_review_items r
       SET status = 'resolved', resolved_at = now()
       FROM locked
       WHERE r.contact_id = locked.id AND r.id = $2 AND r.status = 'pending'
       RETURNING r.id
     ), remaining AS MATERIALIZED (
       SELECT r.id, r.inbound_message_id, r.summary, r.created_at
       FROM ai_review_items r, locked
       WHERE r.contact_id = locked.id AND r.status = 'pending'
         AND r.id <> $2
     ), updated AS (
       UPDATE contacts c
       SET needs_attention = CASE
             WHEN EXISTS (SELECT 1 FROM remaining) THEN true
             WHEN c.attention_reason LIKE 'AI review requested:%' THEN EXISTS (
               SELECT 1 FROM messages m
               WHERE m.contact_id = c.id
                   AND ${unresolvedFailedOutboundSql("m", "c", { ignoreUnlinkedHistoricalMedia: true })}
             )
             ELSE c.needs_attention
           END,
           attention_reason = CASE
             WHEN c.attention_reason LIKE 'AI review requested:%'
               AND EXISTS (SELECT 1 FROM remaining)
             THEN 'AI review requested: ' || COALESCE((
               SELECT STRING_AGG('[#' || r.inbound_message_id::text || '] ' ||
                       LEFT(r.summary, 200), CHR(10) ORDER BY r.created_at, r.id)
               FROM remaining r
             ), '')
             WHEN c.attention_reason LIKE 'AI review requested:%'
               AND EXISTS (
                 SELECT 1 FROM messages m
                 WHERE m.contact_id = c.id
                   AND ${unresolvedFailedOutboundSql("m", "c", { ignoreUnlinkedHistoricalMedia: true })}
               )
             THEN 'Delivery failed: One or more outbound messages need staff review.'
             WHEN c.attention_reason LIKE 'AI review requested:%' THEN NULL
             ELSE c.attention_reason
           END,
           delivery_attention_message_id = CASE
             WHEN c.attention_reason LIKE 'AI review requested:%'
               AND NOT EXISTS (SELECT 1 FROM remaining)
             THEN (
               SELECT m.id FROM messages m
               WHERE m.contact_id = c.id
                 AND ${unresolvedFailedOutboundSql("m", "c", { ignoreUnlinkedHistoricalMedia: true })}
               ORDER BY m.created_at DESC, m.id DESC LIMIT 1
             )
             ELSE c.delivery_attention_message_id
           END,
           updated_at = now()
       FROM locked
       WHERE c.id = locked.id AND EXISTS (SELECT 1 FROM resolved)
       RETURNING c.*
     )
     SELECT * FROM updated`,
    [contactId, reviewId]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

// Delivery problems should not replace a more important reason that already
// needs staff attention, such as an urgent keyword or an AI handoff. Repeated
// delivery failures may update the existing delivery reason with newer detail.
const TEMPORARY_AI_ATTENTION_REASON =
  "AI temporarily unavailable. A staff reply may be needed.";

async function setTemporaryAiAttention(id) {
  return setAttention(id, true, TEMPORARY_AI_ATTENTION_REASON);
}

// Clear only the exact temporary provider-outage flag. This is intentionally
// conditional so a newer booking, safety, delivery, or staff attention reason
// cannot be erased by a later successful AI reply.
async function clearTemporaryAiAttention(id) {
  const result = await pool.query(
    `UPDATE contacts
     SET needs_attention = EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = contacts.id AND r.status = 'pending'
         ),
         attention_reason = CASE WHEN EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = contacts.id AND r.status = 'pending'
         ) THEN 'AI review requested: ' || COALESCE((
           SELECT STRING_AGG('[#' || r.inbound_message_id::text || '] ' ||
             LEFT(r.summary, 200), CHR(10) ORDER BY r.created_at, r.id)
           FROM ai_review_items r
           WHERE r.contact_id = contacts.id AND r.status = 'pending'
         ), '') ELSE NULL END,
         updated_at = now()
     WHERE id = $1
       AND mode = 'ai'
       AND needs_attention = true
       AND attention_reason = $2
     RETURNING *`,
    [id, TEMPORARY_AI_ATTENTION_REASON]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

async function setDeliveryAttention(id, reason, failedMessageId = null) {
  const safeMessageId = Number.isSafeInteger(Number(failedMessageId)) &&
    Number(failedMessageId) > 0 ? Number(failedMessageId) : null;
  const result = await pool.query(
    `UPDATE contacts
     SET needs_attention = true, attention_reason = $1,
         -- Only link a real outbound attempt owned by this same contact.
         -- Legacy/policy warnings with no message stay conservatively unlinked.
         delivery_attention_message_id = (
           SELECT m.id FROM messages m
           WHERE m.id = $3::integer AND m.contact_id = contacts.id
             AND m.role = 'assistant'
             AND m.delivery_status IN ('failed','unknown')
         ),
         updated_at = now()
     WHERE id = $2
       AND (
         needs_attention = false
         OR attention_reason IS NULL
         OR attention_reason LIKE 'Delivery failed:%'
         OR attention_reason LIKE 'Delivery unconfirmed:%'
       )
       -- Protect a newer, specifically identified delivery failure from a
       -- late background/AI retry finishing an older failed attempt.
       AND (
         $3::integer IS NULL
         OR delivery_attention_message_id IS NULL
         OR needs_attention IS DISTINCT FROM TRUE
         OR NOT (
           attention_reason LIKE 'Delivery failed:%'
           OR attention_reason LIKE 'Delivery unconfirmed:%'
         )
         OR NOT EXISTS (
           SELECT 1 FROM messages active_attempt
           JOIN messages reported_attempt
             ON reported_attempt.id = $3::integer
           WHERE active_attempt.id = contacts.delivery_attention_message_id
             AND active_attempt.contact_id = contacts.id
             AND (active_attempt.created_at, active_attempt.id) >
                 (reported_attempt.created_at, reported_attempt.id)
         )
       )
     RETURNING *`,
    [reason, id, safeMessageId]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });

  // A higher-priority booking/clinical/AI-review warning can prevent an
  // actionable delivery failure from replacing the contact attention flag.
  // Such failures still warrant Telegram/Web Push. But a failed attempt
  // superseded by a newer message, an accepted reply, or an explicit staff
  // dismissal must not send a stale notification when its UPDATE was refused.
  let shouldNotify = true;
  if (!updated && safeMessageId !== null) {
    try {
      const state = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM contacts c
           JOIN messages failed ON failed.contact_id = c.id
           WHERE c.id = $1 AND failed.id = $2::integer
             AND ${unresolvedFailedOutboundSql("failed", "c")}
             AND NOT (
               c.needs_attention IS TRUE
               AND (
                 c.attention_reason LIKE 'Delivery failed:%'
                 OR c.attention_reason LIKE 'Delivery unconfirmed:%'
               )
               AND c.delivery_attention_message_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM messages active_attempt
                 WHERE active_attempt.id = c.delivery_attention_message_id
                   AND active_attempt.contact_id = c.id
                   AND (active_attempt.created_at, active_attempt.id) >
                       (failed.created_at, failed.id)
               )
             )
         ) AS actionable`,
        [id, safeMessageId]
      );
      shouldNotify = state.rows[0]?.actionable === true;
    } catch (error) {
      // If read-only notification reconciliation is unavailable, preserve
      // the old best-effort escalation behavior rather than changing the
      // outbound send result or silently hiding a real clinical escalation.
      console.error(
        `Could not verify delivery failure notification for contact ${id} message ${safeMessageId}:`,
        error
      );
    }
  }
  if (shouldNotify) {
    notifyTelegram(
      telegramImmediateAlerts.sendDeliveryFailureAlert({ contactId: id, reason }),
      "delivery failure",
      id
    );
    notifyWebPush(id, "delivery_failure");
  }

  return updated;
}

// Clear only a reply-resolved delivery or routine staff-owned attention flag.
// Real booking, safety, AI-review and clinical tasks still require deliberate
// staff resolution. Keep failed media actionable even after later text replies.
// The SQL tests the latest customer turn atomically to avoid stale-send races.
async function clearDeliveryAttentionIfNoFailedMessages(id, expectedReason = null) {
  const result = await pool.query(
    `UPDATE contacts c
     SET needs_attention = EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = c.id AND r.status = 'pending'
         ),
         attention_reason = CASE WHEN EXISTS (
           SELECT 1 FROM ai_review_items r
           WHERE r.contact_id = c.id AND r.status = 'pending'
         ) THEN 'AI review requested: ' || COALESCE((
           SELECT STRING_AGG('[#' || r.inbound_message_id::text || '] ' ||
             LEFT(r.summary, 200), CHR(10) ORDER BY r.created_at, r.id)
           FROM ai_review_items r
           WHERE r.contact_id = c.id AND r.status = 'pending'
         ), '') ELSE NULL END,
         delivery_attention_message_id = NULL,
         updated_at = now()
     WHERE c.id = $1
       AND ($2::text IS NULL OR c.attention_reason = $2::text)
       AND c.needs_attention = true
       AND (
         c.attention_reason LIKE 'Delivery failed:%'
         OR c.attention_reason LIKE 'Delivery unconfirmed:%'
         OR (
           c.mode = 'human'
           AND c.attention_reason = 'New message — conversation is staff-owned.'
         )
       )
       AND EXISTS (
         SELECT 1 FROM messages reply
         WHERE reply.contact_id = c.id
           AND ${acceptedDirectReplySql("reply")}
           -- Staff-owned waiting is only resolved by a *staff* response,
           -- not an AI acknowledgement or a follow-up generated before
           -- the manual takeover.
           AND (
             c.attention_reason IS DISTINCT FROM
               'New message — conversation is staff-owned.'
             OR reply.sent_by_username IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages inbound
             WHERE inbound.contact_id = c.id
               AND inbound.role = 'user'
               AND (inbound.created_at, inbound.id) >
                   (reply.created_at, reply.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages failed
             WHERE failed.contact_id = c.id
               AND ${unresolvedFailedOutboundSql("failed", "c")}
               -- Newer failed sends cannot be hidden by an earlier reply.
               -- Older failed media also remains an actionable attachment.
               AND (
                 (failed.created_at, failed.id) > (reply.created_at, reply.id)
                 OR ${failedMediaSql("failed")}
               )
           )
       )
     RETURNING *`,
    [id, expectedReason]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { contact: updated });
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
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

async function setInboxArchived(id, archived) {
  const result = await pool.query(
    `UPDATE contacts
     SET inbox_archived_at = CASE WHEN $1::boolean THEN now() ELSE NULL END
     WHERE id = $2
     RETURNING id, inbox_archived_at`,
    [archived, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id, { profileOnly: true });
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
  if (updated) publishContactChange(updated.id, { contact: updated });
  return updated;
}

module.exports = {
  getOrCreateContact,
  getOrCreateChannelContact,
  getContactById,
  canSendAutomaticReviewMedia,
  hasPendingClinicalAiReview,
  getTcmReviewEvidence,
  updateContactName,
  listConversations,
  searchConversationDirectory,
  listContacts,
  listContactsPage,
  createContact,
  updateContact,
  normalizeWhatsappNumber,
  presentPortalContact,
  takeOver,
  returnToAi,
  approveSecondaryManualAi,
  clearStaffAssistStateIfUnchanged,
  setAttention,
  setAiReviewAttention,
  dismissAttentionAndReviews,
  resolveAiReviewItem,
  setTemporaryAiAttention,
  clearTemporaryAiAttention,
  setDeliveryAttention,
  clearDeliveryAttentionIfNoFailedMessages,
  setUnread,
  setInboxArchived,
  setFollowUp,
  TEMPORARY_AI_ATTENTION_REASON,
};
