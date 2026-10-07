const { pool } = require("./db");
const {
  CONVERSATION_LOCK_NAMESPACE,
  lockConversation,
  lockWhatsappMessageId,
} = require("./conversationLock");
const mediaStorage = require("../services/mediaStorageService");
const realtimeEvents = require("../utils/realtimeEvents");

const MAX_PORTAL_PAGE_SIZE = 100;

function clampPageSize(limit, fallback = 50) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_PORTAL_PAGE_SIZE);
}

// Media write paths now pass Buffer objects straight through to R2 so an
// upload does not allocate a ~33% larger base64 string and then decode it back
// into another Buffer. Base64 strings remain accepted only as a compatibility
// fallback for any older internal caller while the active paths use Buffers.
async function persistMediaIfPresent(mediaData, mediaMimeType, contactId) {
  if (!mediaData) return null;

  let buffer;
  if (Buffer.isBuffer(mediaData)) {
    buffer = mediaData;
  } else if (typeof mediaData === "string") {
    buffer = Buffer.from(mediaData, "base64");
  } else if (ArrayBuffer.isView(mediaData)) {
    buffer = Buffer.from(mediaData.buffer, mediaData.byteOffset, mediaData.byteLength);
  } else {
    throw new TypeError("Media attachment must be a Buffer, typed array, or base64 string.");
  }

  return mediaStorage.uploadMedia(buffer, mediaMimeType, { contactId });
}

// Mirrors persistMediaIfPresent's contract in reverse: resolves a stored key
// back into the {media_base64, media_mime_type} shape every caller already
// expects. Full buffering is intentionally reserved for callers that really
// need the bytes (AI image context and message retry), not browser playback.
async function resolveMediaBase64(mediaKey, mediaMimeType) {
  if (!mediaKey) return null;
  const buffer = await mediaStorage.downloadMedia(mediaKey);
  return { media_base64: buffer.toString("base64"), media_mime_type: mediaMimeType };
}

// Shared by the includeMedia=true paths in getMessagePageForContact (the
// getMessagesForContact one resolves inline since it always needs the full
// row shape). Renames media_key -> media_base64 in place to match what
// callers historically received.
async function resolveMediaKeysInRows(rows, includeMedia) {
  if (!includeMedia) return rows;
  for (const row of rows) {
    const key = row.media_key;
    delete row.media_key;
    row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  }
  return rows;
}

const LIGHTWEIGHT_MESSAGE_COLUMNS = `
  id,
  contact_id,
  role,
  content,
  whatsapp_message_id,
  sent_by_username,
  media_url,
  (media_key IS NOT NULL) AS has_media_attachment,
  media_mime_type,
  created_at,
  delivery_status,
  delivery_error,
  is_automated_follow_up,
  reply_to_provider_message_id,
  is_forwarded
`;
const PORTAL_REACTIONS_COLUMN = `
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object('emoji', mr.emoji)
        ORDER BY mr.id
      )
      FROM message_reactions mr
      WHERE mr.target_message_id = messages.id
        AND mr.emoji <> ''
    ),
    '[]'::jsonb
  ) AS reactions
`;
const PORTAL_REPLY_PREVIEW_COLUMN = `
  (
    SELECT jsonb_build_object(
      'id', quoted.id,
      'role', quoted.role,
      'content', quoted.content,
      'sent_by_username', quoted.sent_by_username,
      'media_mime_type', quoted.media_mime_type,
      'has_media_attachment', (quoted.media_key IS NOT NULL),
      'media_url', quoted.media_url
    )
    FROM messages quoted
    WHERE quoted.contact_id = messages.contact_id
      AND quoted.whatsapp_message_id = messages.reply_to_provider_message_id
    LIMIT 1
  ) AS reply_preview
`;


/**
 * Saves a message for a contact. Large media bytes are deliberately excluded
 * from RETURNING so an INSERT of a photo/voice note does not immediately send
 * the same base64 payload back out of Neon again.
 */
async function saveMessage(
  contactId,
  role,
  content,
  whatsappMessageId = null,
  sentByUsername = null,
  mediaUrl = null,
  mediaBase64 = null,
  mediaMimeType = null,
  options = {}
) {
  const providedMediaKey = String(options?.mediaKey || "").trim() || null;
  if (providedMediaKey && mediaBase64) {
    throw new TypeError("Provide media bytes or an existing media key, not both.");
  }
  const mediaKey =
    providedMediaKey ||
    (await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId));
  const whatsappTemplate = options?.whatsappTemplate || null;
  const initialDeliveryStatus = options?.initialDeliveryStatus || null;
  const initialDeliveryError = options?.initialDeliveryError || null;
  const replyToProviderMessageId = options?.replyToProviderMessageId || null;
  const isForwarded = options?.isForwarded === true;

  if (!whatsappTemplate) {
    const result = await pool.query(
      `WITH conversation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
       )
       INSERT INTO messages (
         contact_id, role, content, whatsapp_message_id, sent_by_username,
         media_url, media_key, media_mime_type,
         reply_to_provider_message_id, is_forwarded
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       FROM conversation_lock
       RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
      [
        contactId,
        role,
        content,
        whatsappMessageId,
        sentByUsername,
        mediaUrl,
        mediaKey,
        mediaMimeType,
        replyToProviderMessageId,
        isForwarded,
      ]
    );
    return result.rows[0];
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO messages (
       contact_id, role, content, whatsapp_message_id, sent_by_username,
       media_url, media_key, media_mime_type, whatsapp_template,
       delivery_status, delivery_error, reply_to_provider_message_id, is_forwarded
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13
     FROM conversation_lock
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}, whatsapp_template`,
    [
      contactId,
      role,
      content,
      whatsappMessageId,
      sentByUsername,
      mediaUrl,
      mediaKey,
      mediaMimeType,
      JSON.stringify(whatsappTemplate),
      initialDeliveryStatus,
      initialDeliveryError,
      replyToProviderMessageId,
      isForwarded,
    ]
  );
  return result.rows[0];
}

/**
 * Atomically stores a newly received WhatsApp message. Meta can retry the same
 * webhook while an earlier request is still running, so a separate SELECT then
 * INSERT is not safe. The unique whatsapp_message_id constraint and
 * ON CONFLICT make exactly one request the owner of the message.
 */
async function saveInboundMessageIfNew(
  contactId,
  content,
  whatsappMessageId,
  mediaBase64 = null,
  mediaMimeType = null
) {
  const mediaKey = await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId);
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO messages (
       contact_id, role, content, whatsapp_message_id, media_key, media_mime_type
     )
     SELECT $1, 'user', $2, $3, $4, $5
     FROM conversation_lock
     ON CONFLICT (whatsapp_message_id) DO NOTHING
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [contactId, content, whatsappMessageId, mediaKey, mediaMimeType]
  );
  return result.rows[0] || null;
}

/** Updates the placeholder saved before media download/transcription finishes. */
async function updateInboundMessage(messageId, contactId, content, mediaBase64, mediaMimeType) {
  const mediaKey = await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId);
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $2::integer)
     )
     UPDATE messages
     SET content = $3, media_key = $4, media_mime_type = $5
     FROM conversation_lock
     WHERE id = $1 AND contact_id = $2 AND role = 'user'
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, contactId, content, mediaKey, mediaMimeType]
  );
  return result.rows[0] || null;
}

/**
 * Recent history used internally by the AI. This stays array-based so the AI
 * path is independent from portal pagination.
 */
async function getMessagesForContact(contactId, limit = 50, includeMedia = true) {
  const safeLimit = clampPageSize(limit);
  const mediaColumn = includeMedia
    ? "media_key"
    : "(media_key IS NOT NULL) AS has_media_attachment";
  const result = await pool.query(
    `SELECT id, role, content, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type FROM messages
     WHERE contact_id = $1
       AND (
         role <> 'assistant'
         OR delivery_status IS NULL
         OR delivery_status NOT IN ('failed', 'unknown')
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [contactId, safeLimit]
  );
  const rows = result.rows.reverse();
  if (!includeMedia) return rows;

  // Resolve each row's R2 key back into media_base64 so this keeps the same
  // shape callers already relied on (see getHistoryForContact/AI context).
  for (const row of rows) {
    const key = row.media_key;
    delete row.media_key;
    row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  }
  return rows;
}

async function wasPromoRecentlySentWithExecutor(
  executor,
  contactId,
  imageUrl,
  caption,
  withinHours = 24
) {
  const hours = Number(withinHours);
  if (
    !executor ||
    typeof executor.query !== "function" ||
    !imageUrl ||
    typeof caption !== "string" ||
    !Number.isSafeInteger(hours) ||
    hours < 1
  ) {
    return false;
  }

  const result = await executor.query(
    `SELECT 1
     FROM messages
     WHERE contact_id = $1
       AND role = 'assistant'
       AND media_url = $2
       AND content = $3
       AND whatsapp_message_id IS NOT NULL
       AND created_at >= NOW() - ($4::integer * INTERVAL '1 hour')
       AND (
         delivery_status IS NULL
         OR delivery_status NOT IN ('failed', 'unknown')
       )
     LIMIT 1`,
    [contactId, imageUrl, caption, hours]
  );
  return result.rowCount > 0;
}

async function wasPromoRecentlySent(
  contactId,
  imageUrl,
  caption,
  withinHours = 24
) {
  return wasPromoRecentlySentWithExecutor(
    pool,
    contactId,
    imageUrl,
    caption,
    withinHours
  );
}

function storedConfigMediaId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(
    /\/(?:promo-images|api\/config\/result-media\/image)\/(\d+)(?:[/?#]|$)/
  );
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function wasMediaRecentlySentWithExecutor(
  executor,
  contactId,
  imageUrl,
  withinHours = 168
) {
  const hours = Number(withinHours);
  if (
    !executor ||
    typeof executor.query !== "function" ||
    !imageUrl ||
    !Number.isSafeInteger(hours) ||
    hours < 1
  ) {
    return false;
  }

  const storedId = storedConfigMediaId(imageUrl);
  const result = storedId
    ? await executor.query(
        `SELECT 1
         FROM messages
         WHERE contact_id = $1
           AND role = 'assistant'
           AND (
             media_url = $2
             OR split_part(split_part(media_url, '?', 1), '#', 1)
                  LIKE '%/promo-images/' || $4::integer::text
             OR split_part(split_part(media_url, '?', 1), '#', 1)
                  LIKE '%/api/config/result-media/image/' || $4::integer::text
           )
           AND whatsapp_message_id IS NOT NULL
           AND created_at >= NOW() - ($3::integer * INTERVAL '1 hour')
           AND (
             delivery_status IS NULL
             OR delivery_status NOT IN ('failed', 'unknown')
           )
         LIMIT 1`,
        [contactId, imageUrl, hours, storedId]
      )
    : await executor.query(
        `SELECT 1
         FROM messages
         WHERE contact_id = $1
           AND role = 'assistant'
           AND media_url = $2
           AND whatsapp_message_id IS NOT NULL
           AND created_at >= NOW() - ($3::integer * INTERVAL '1 hour')
           AND (
             delivery_status IS NULL
             OR delivery_status NOT IN ('failed', 'unknown')
           )
         LIMIT 1`,
        [contactId, imageUrl, hours]
      );
  return result.rowCount > 0;
}

async function wasMediaRecentlySent(
  contactId,
  imageUrl,
  withinHours = 168
) {
  return wasMediaRecentlySentWithExecutor(
    pool,
    contactId,
    imageUrl,
    withinHours
  );
}

async function getMostRecentlySentMediaUrlWithExecutor(
  executor,
  contactId,
  imageUrls
) {
  const urls = Array.isArray(imageUrls)
    ? [...new Set(
        imageUrls
          .map((value) => String(value || "").trim())
          .filter(Boolean)
      )]
    : [];
  if (
    !executor ||
    typeof executor.query !== "function" ||
    !contactId ||
    urls.length === 0
  ) {
    return null;
  }

  const storedIds = [...new Set(
    urls.map(storedConfigMediaId).filter((id) => id !== null)
  )];
  const result = storedIds.length > 0
    ? await executor.query(
        `SELECT media_url
         FROM messages
         WHERE contact_id = $1
           AND role = 'assistant'
           AND (
             media_url = ANY($2::text[])
             OR EXISTS (
               SELECT 1
               FROM unnest($3::int[]) AS ids(stored_id)
               WHERE split_part(split_part(media_url, '?', 1), '#', 1)
                       LIKE '%/promo-images/' || stored_id::text
                  OR split_part(split_part(media_url, '?', 1), '#', 1)
                       LIKE '%/api/config/result-media/image/' || stored_id::text
             )
           )
           AND whatsapp_message_id IS NOT NULL
           AND (
             delivery_status IS NULL
             OR delivery_status NOT IN ('failed', 'unknown')
           )
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [contactId, urls, storedIds]
      )
    : await executor.query(
        `SELECT media_url
         FROM messages
         WHERE contact_id = $1
           AND role = 'assistant'
           AND media_url = ANY($2::text[])
           AND whatsapp_message_id IS NOT NULL
           AND (
             delivery_status IS NULL
             OR delivery_status NOT IN ('failed', 'unknown')
           )
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [contactId, urls]
      );
  return result.rows[0]?.media_url || null;
}

async function getMostRecentlySentMediaUrl(contactId, imageUrls) {
  return getMostRecentlySentMediaUrlWithExecutor(
    pool,
    contactId,
    imageUrls
  );
}

/**
 * Lightweight portal page. Initial/before pages fetch one extra row so the
 * UI knows whether a "Load older messages" button is needed without a second
 * COUNT(*) query. afterId returns every unseen lightweight row so an SSE
 * reconnect can fully catch up even when more than 100 messages arrived while
 * the browser was disconnected.
 */
async function getMessagePageForContact(
  contactId,
  { limit = 50, beforeId = null, afterId = null, includeMedia = false } = {}
) {
  const safeLimit = clampPageSize(limit);
  const mediaColumn = includeMedia
    ? "media_key"
    : "(media_key IS NOT NULL) AS has_media_attachment";

  if (afterId != null) {
    const result = await pool.query(
      `SELECT id, role, content, whatsapp_message_id, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
              delivery_status, delivery_error, is_automated_follow_up, whatsapp_template,
              reply_to_provider_message_id, is_forwarded,
              ${PORTAL_REACTIONS_COLUMN},
              ${PORTAL_REPLY_PREVIEW_COLUMN}
       FROM messages
       WHERE contact_id = $1 AND id > $2
       ORDER BY id ASC`,
      [contactId, afterId]
    );
    return { rows: await resolveMediaKeysInRows(result.rows, includeMedia), hasMore: false };
  }

  const params = [contactId];
  let cursorClause = "";
  if (beforeId != null) {
    params.push(beforeId);
    cursorClause = ` AND id < $${params.length}`;
  }
  params.push(safeLimit + 1);

  const result = await pool.query(
    `SELECT id, role, content, whatsapp_message_id, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
            delivery_status, delivery_error, is_automated_follow_up, whatsapp_template,
            reply_to_provider_message_id, is_forwarded,
            ${PORTAL_REACTIONS_COLUMN},
            ${PORTAL_REPLY_PREVIEW_COLUMN}
     FROM messages
     WHERE contact_id = $1${cursorClause}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > safeLimit;
  const page = hasMore ? result.rows.slice(0, safeLimit) : result.rows;
  return { rows: await resolveMediaKeysInRows(page.reverse(), includeMedia), hasMore };
}

// Returns only the R2 reference and MIME metadata for one authenticated
// message lookup. The browser streaming route uses this instead of loading
// the whole object through Postgres/base64 before it can start responding.
async function getMessageMediaReferenceForContact(contactId, messageId) {
  const result = await pool.query(
    `SELECT media_key, media_mime_type
     FROM messages
     WHERE id = $1 AND contact_id = $2 AND media_key IS NOT NULL`,
    [messageId, contactId]
  );
  return result.rows[0] || null;
}

// Full-byte lookup used only where the application genuinely needs the entire
// attachment (for example the newest photo sent to the AI). Browser playback
// should use getMessageMediaReferenceForContact + R2 streaming instead.
async function getMessageMediaForContact(contactId, messageId) {
  const row = await getMessageMediaReferenceForContact(contactId, messageId);
  if (!row) return null;
  return resolveMediaBase64(row.media_key, row.media_mime_type);
}

async function setMessageMediaKeyById(
  messageId,
  contactId,
  mediaKey,
  mediaMimeType
) {
  const normalizedKey = String(mediaKey || "").trim();
  if (!normalizedKey) throw new TypeError("mediaKey is required.");

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $2::integer)
     )
     UPDATE messages
     SET media_key = $3, media_mime_type = $4
     FROM conversation_lock
     WHERE id = $1 AND contact_id = $2
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, contactId, normalizedKey, mediaMimeType || null]
  );
  return result.rows[0] || null;
}

async function setMessageContentById(messageId, contactId, content) {
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $2::integer)
     )
     UPDATE messages
     SET content = $3
     FROM conversation_lock
     WHERE id = $1 AND contact_id = $2 AND role = 'assistant'
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, contactId, content]
  );
  return result.rows[0] || null;
}

async function getMessageForForward(contactId, messageId) {
  const result = await pool.query(
    `SELECT m.id, m.contact_id, m.role, m.content, m.whatsapp_message_id,
            m.sent_by_username, m.media_url, m.media_key, m.media_mime_type,
            m.created_at, m.delivery_status, m.delivery_error,
            m.is_automated_follow_up, m.whatsapp_template,
            m.reply_to_provider_message_id, m.is_forwarded
     FROM messages m
     WHERE m.id = $1 AND m.contact_id = $2
     LIMIT 1`,
    [messageId, contactId]
  );
  return result.rows[0] || null;
}

// Retry needs the original stored attachment bytes. This is deliberately a
// single-message lookup and is only used by the authenticated retry route;
// normal Inbox payloads remain lightweight and never include base64 media.
async function getMessageForRetry(contactId, messageId) {
  const result = await pool.query(
    `SELECT m.id, m.contact_id, m.role, m.content, m.whatsapp_message_id,
            m.sent_by_username, m.media_url, m.media_key, m.media_mime_type,
            m.created_at, m.delivery_status, m.delivery_error,
            m.is_automated_follow_up, m.whatsapp_template,
            m.reply_to_provider_message_id, m.is_forwarded,
            EXISTS (
              SELECT 1
              FROM scheduled_messages sm
              WHERE sm.message_id = m.id
            ) AS is_scheduled_message
     FROM messages m
     WHERE m.id = $1 AND m.contact_id = $2`,
    [messageId, contactId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const key = row.media_key;
  const mimeType = String(row.media_mime_type || "").toLowerCase();
  if (key && mimeType.startsWith("video/")) {
    row.media_base64 = null;
    return row;
  }
  delete row.media_key;
  row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  return row;
}

async function getMessageForReplyContext(contactId, messageId) {
  const result = await pool.query(
    `SELECT id, contact_id, role, content, whatsapp_message_id,
            sent_by_username, media_url,
            (media_key IS NOT NULL) AS has_media_attachment,
            media_mime_type, created_at, delivery_status
     FROM messages
     WHERE id = $1 AND contact_id = $2
     LIMIT 1`,
    [messageId, contactId]
  );
  return result.rows[0] || null;
}

// Resyncs the delivery state for messages that are already visible in an
// Inbox thread after its SSE connection reconnects. Restricting by contact id
// prevents message ids from another conversation being exposed accidentally.
async function getMessageByProviderIdForContact(
  contactId,
  providerMessageId,
  queryable = pool
) {
  if (!providerMessageId) return null;
  const result = await queryable.query(
    `SELECT ${LIGHTWEIGHT_MESSAGE_COLUMNS}
     FROM messages
     WHERE contact_id = $1 AND whatsapp_message_id = $2
     LIMIT 1`,
    [contactId, providerMessageId]
  );
  return result.rows[0] || null;
}

async function insertSocialProviderMessageAlias(
  client,
  messageId,
  providerMessageId,
  contactId
) {
  const normalized = String(providerMessageId || "").trim();
  const separator = normalized.indexOf(":");
  const channel = separator > 0 ? normalized.slice(0, separator) : "";
  if (!["facebook", "instagram"].includes(channel)) {
    throw new TypeError("Social provider message ids must be prefixed with facebook: or instagram:.");
  }

  const inserted = await client.query(
    `INSERT INTO social_provider_message_ids (
       provider_message_id, message_id, contact_id, channel
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING provider_message_id, message_id, contact_id, channel`,
    [normalized, messageId, contactId, channel]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await client.query(
    `SELECT provider_message_id, message_id, contact_id, channel
     FROM social_provider_message_ids
     WHERE provider_message_id = $1
     LIMIT 1`,
    [normalized]
  );
  return existing.rows[0] || null;
}

async function registerSocialProviderMessageAlias(
  messageId,
  providerMessageId,
  queryable = null
) {
  const ownsClient = queryable == null;
  const client = ownsClient ? await pool.connect() : queryable;
  try {
    await client.query("BEGIN");
    const messageResult = await client.query(
      "SELECT contact_id FROM messages WHERE id = $1",
      [messageId]
    );
    const contactId = messageResult.rows[0]?.contact_id;
    if (!contactId) {
      await client.query("COMMIT");
      return null;
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,
      [contactId]
    );
    const alias = await insertSocialProviderMessageAlias(
      client,
      messageId,
      providerMessageId,
      contactId
    );
    await client.query("COMMIT");
    return alias;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

async function getMessageByAnyProviderIdForContact(
  contactId,
  providerMessageId,
  queryable = pool
) {
  const direct = await getMessageByProviderIdForContact(
    contactId,
    providerMessageId,
    queryable
  );
  if (direct) return direct;

  const result = await queryable.query(
    `SELECT
       m.id,
       m.contact_id,
       m.role,
       m.content,
       m.whatsapp_message_id,
       m.sent_by_username,
       m.media_url,
       (m.media_key IS NOT NULL) AS has_media_attachment,
       m.media_mime_type,
       m.created_at,
       m.delivery_status,
       m.delivery_error,
       m.is_automated_follow_up
     FROM social_provider_message_ids s
     JOIN messages m ON m.id = s.message_id
     WHERE s.contact_id = $1
       AND s.provider_message_id = $2
     LIMIT 1`,
    [contactId, providerMessageId]
  );
  return result.rows[0] || null;
}

function socialProviderAliasRecorder(messageId, channel) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  if (!["facebook", "instagram"].includes(normalizedChannel)) return null;

  return async (externalMessageId) => {
    const externalId = String(externalMessageId || "").trim();
    if (!externalId) return null;
    return registerSocialProviderMessageAlias(
      messageId,
      `${normalizedChannel}:${externalId}`
    );
  };
}

async function getDeliveryStatusesForContact(contactId, messageIds) {
  if (!messageIds.length) return [];
  const result = await pool.query(
    `SELECT id, whatsapp_message_id, delivery_status, delivery_error,
            ${PORTAL_REACTIONS_COLUMN}
     FROM messages
     WHERE contact_id = $1 AND id = ANY($2::int[])`,
    [contactId, messageIds]
  );
  return result.rows;
}

// Uses a transaction-scoped Postgres lock so the same failed message cannot be
// retried concurrently by different server instances. Keeping the transaction
// on one checked-out connection also works when Neon is using a connection
// pooler, and a dropped server process releases the lock automatically.
async function acquireMessageRetryLock(messageId) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [messageId]
    );
    if (!result.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      client.release();
      return null;
    }

    let released = false;
    return async function releaseMessageRetryLock() {
      if (released) return;
      released = true;

      try {
        await client.query("COMMIT");
        client.release();
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        client.release(true);
        throw err;
      }
    };
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    client.release(true);
    throw err;
  }
}

/**
 * Attach Meta's WAMID and mark the request as pending. "pending" means Meta
 * accepted the request, while sent/delivered/read still come from webhooks.
 */
async function deleteUnsentAssistantMessage(messageId) {
  const result = await pool.query(
    `DELETE FROM messages
     WHERE id = $1
       AND role = 'assistant'
       AND whatsapp_message_id IS NULL
       AND delivery_status IS NULL
     RETURNING id, contact_id`,
    [messageId]
  );
  return result.rows[0] || null;
}

async function setWhatsappMessageId(messageId, whatsappMessageId) {
  const targetWhatsappMessageId = String(whatsappMessageId || "").trim();
  if (!targetWhatsappMessageId) return null;

  const client = await pool.connect();
  let transactionStarted = false;
  let reactionUpdate = null;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Serialize the WAMID becoming visible locally with reaction delivery. This
    // closes the last race where each side could miss the other's uncommitted
    // row and leave a reaction pending forever.
    await lockWhatsappMessageId(client, targetWhatsappMessageId);

    const result = await client.query(
      `UPDATE messages
       SET whatsapp_message_id = $2, delivery_status = 'pending', delivery_error = NULL
       WHERE id = $1
       RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
      [messageId, targetWhatsappMessageId]
    );
    const updated = result.rows[0] || null;
    if (!updated) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }

    // Reaction bookkeeping must never turn a provider-accepted send into an
    // application failure. Keep the WAMID update even if reconciliation itself
    // has an unexpected error.
    await client.query("SAVEPOINT whatsapp_reaction_reconcile");
    try {
      reactionUpdate = await reconcilePendingWhatsappReactionsForTarget(
        client,
        {
          id: updated.id,
          contact_id: updated.contact_id,
        },
        targetWhatsappMessageId
      );
      await client.query("RELEASE SAVEPOINT whatsapp_reaction_reconcile");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT whatsapp_reaction_reconcile");
      await client.query("RELEASE SAVEPOINT whatsapp_reaction_reconcile");
      console.error(
        `Failed to reconcile pending WhatsApp reactions for message ${updated.id}:`,
        err
      );
      reactionUpdate = null;
    }

    await client.query("COMMIT");
    transactionStarted = false;

    if (reactionUpdate?.changed) {
      realtimeEvents.publish("conversation_changed", {
        contactId: reactionUpdate.contactId,
        messageId: reactionUpdate.messageId,
        reactions: reactionUpdate.reactions,
        reason: "reaction",
      });
    }

    return updated;
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

async function setSocialProviderMessageId(
  messageId,
  providerMessageId,
  deliveryStatus = null
) {
  if (!providerMessageId) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const contactResult = await client.query(
      "SELECT contact_id FROM messages WHERE id = $1",
      [messageId]
    );
    const contactId = contactResult.rows[0]?.contact_id;
    if (!contactId) {
      await client.query("COMMIT");
      return null;
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,
      [contactId]
    );
    const result = await client.query(
      `UPDATE messages
       SET whatsapp_message_id = $2, delivery_status = $3, delivery_error = NULL
       WHERE id = $1
       RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
      [messageId, providerMessageId, deliveryStatus]
    );
    const row = result.rows[0] || null;
    if (row) {
      await insertSocialProviderMessageAlias(
        client,
        messageId,
        providerMessageId,
        contactId
      );
    }
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Records an outcome for a send attempt that produced no new WAMID. Clearing
// the previous WAMID keeps a delayed webhook from an older attempt from being
// applied to the current failure.
async function setDeliveryStatusById(messageId, status, errorText = null) {
  const result = await pool.query(
    `UPDATE messages
     SET whatsapp_message_id = NULL, delivery_status = $2, delivery_error = $3
     WHERE id = $1
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, status, errorText]
  );
  return result.rows[0] || null;
}

async function markDeliveryUnknownIfUnconfirmed(messageId, errorText = null) {
  const updated = await pool.query(
    `UPDATE messages
     SET whatsapp_message_id = NULL,
         delivery_status = 'unknown',
         delivery_error = $2
     WHERE id = $1
       AND role = 'assistant'
       AND (
         delivery_status IS NULL
         OR delivery_status IN ('failed', 'unknown')
       )
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, errorText]
  );
  if (updated.rows[0]) {
    return {
      marked: true,
      accepted: false,
      message: updated.rows[0],
    };
  }

  const current = await pool.query(
    `SELECT ${LIGHTWEIGHT_MESSAGE_COLUMNS}
     FROM messages
     WHERE id = $1`,
    [messageId]
  );
  const message = current.rows[0] || null;
  const status = String(message?.delivery_status || "").toLowerCase();
  return {
    marked: false,
    accepted:
      ["pending", "sent", "delivered", "read"].includes(status) ||
      (
        Boolean(message?.whatsapp_message_id) &&
        !["failed", "unknown"].includes(status)
      ),
    message,
  };
}

async function hasStaffReplyAfter(contactId, inboundMessageId, query = pool.query.bind(pool)) {
  const safeContactId = Number(contactId);
  const safeInboundMessageId = Number(inboundMessageId);
  if (
    !Number.isSafeInteger(safeContactId) ||
    safeContactId <= 0 ||
    !Number.isSafeInteger(safeInboundMessageId) ||
    safeInboundMessageId <= 0
  ) {
    return false;
  }

  const result = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM messages inbound
       JOIN messages staff
         ON staff.contact_id = inbound.contact_id
        AND staff.role = 'assistant'
        AND staff.sent_by_username IS NOT NULL
        AND COALESCE(staff.delivery_status, 'pending') <> 'failed'
        AND (staff.created_at, staff.id) > (inbound.created_at, inbound.id)
       WHERE inbound.id = $2
         AND inbound.contact_id = $1
         AND inbound.role = 'user'
     ) AS has_staff_reply`,
    [safeContactId, safeInboundMessageId]
  );
  return result.rows[0]?.has_staff_reply === true;
}

function normalizeReactionTimestamp(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function findWhatsappReactionTarget(queryable, targetWhatsappMessageId) {
  const result = await queryable.query(
    `WITH candidates AS (
       SELECT m.id, m.contact_id, 0 AS priority
       FROM messages m
       WHERE m.whatsapp_message_id = $1

       UNION ALL

       SELECT m.id, m.contact_id, 1 AS priority
       FROM outbound_message_evidence evidence
       JOIN messages m ON m.id = evidence.message_id
       WHERE evidence.channel = 'whatsapp'
         AND evidence.accepted = true
         AND evidence.provider_message_id = $1

       UNION ALL

       SELECT m.id, m.contact_id, 2 AS priority
       FROM inbound_outbound_attempts attempt
       JOIN inbound_processing_jobs job
         ON job.id = attempt.processing_job_id
        AND job.channel = 'whatsapp'
       JOIN messages m ON m.id = attempt.assistant_message_id
       WHERE attempt.outcome = 'accepted'
         AND attempt.provider_message_id = $1
     )
     SELECT id, contact_id
     FROM candidates
     ORDER BY priority ASC
     LIMIT 1`,
    [targetWhatsappMessageId]
  );
  return result.rows[0] || null;
}

async function readActiveWhatsappReactions(queryable, targetMessageId) {
  const result = await queryable.query(
    `SELECT COALESCE(
       jsonb_agg(jsonb_build_object('emoji', emoji) ORDER BY id)
         FILTER (WHERE emoji <> ''),
       '[]'::jsonb
     ) AS reactions
     FROM message_reactions
     WHERE target_message_id = $1`,
    [targetMessageId]
  );
  return result.rows[0]?.reactions || [];
}

async function upsertWhatsappReactionState(
  queryable,
  {
    targetMessageId,
    contactId,
    reactorKey,
    emoji,
    providerReactionMessageId,
    providerTimestamp,
    receivedAt,
  }
) {
  const result = await queryable.query(
    `INSERT INTO message_reactions (
       target_message_id,
       contact_id,
       reactor_key,
       emoji,
       provider_reaction_message_id,
       provider_timestamp,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)
     ON CONFLICT (target_message_id, reactor_key)
     DO UPDATE SET
       contact_id = EXCLUDED.contact_id,
       emoji = EXCLUDED.emoji,
       provider_reaction_message_id = EXCLUDED.provider_reaction_message_id,
       provider_timestamp = EXCLUDED.provider_timestamp,
       updated_at = EXCLUDED.updated_at
     WHERE (
       EXCLUDED.provider_timestamp IS NOT NULL
       AND (
         message_reactions.provider_timestamp IS NULL
         OR EXCLUDED.provider_timestamp >= message_reactions.provider_timestamp
       )
     ) OR (
       EXCLUDED.provider_timestamp IS NULL
       AND message_reactions.provider_timestamp IS NULL
       AND EXCLUDED.updated_at >= message_reactions.updated_at
     )
     RETURNING id`,
    [
      targetMessageId,
      contactId,
      reactorKey,
      emoji,
      providerReactionMessageId,
      providerTimestamp,
      receivedAt,
    ]
  );
  return Boolean(result.rows[0]);
}

async function queuePendingWhatsappReaction(
  queryable,
  {
    targetWhatsappMessageId,
    reactorWhatsappId,
    reactorKey,
    emoji,
    providerReactionMessageId,
    providerTimestamp,
    receivedAt,
  }
) {
  const result = await queryable.query(
    `INSERT INTO pending_whatsapp_reactions (
       target_whatsapp_message_id,
       reactor_key,
       reactor_whatsapp_id,
       emoji,
       provider_reaction_message_id,
       provider_timestamp,
       received_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)
     ON CONFLICT (target_whatsapp_message_id, reactor_key)
     DO UPDATE SET
       reactor_whatsapp_id = EXCLUDED.reactor_whatsapp_id,
       emoji = EXCLUDED.emoji,
       provider_reaction_message_id = EXCLUDED.provider_reaction_message_id,
       provider_timestamp = EXCLUDED.provider_timestamp,
       updated_at = EXCLUDED.updated_at
     WHERE (
       EXCLUDED.provider_timestamp IS NOT NULL
       AND (
         pending_whatsapp_reactions.provider_timestamp IS NULL
         OR EXCLUDED.provider_timestamp >= pending_whatsapp_reactions.provider_timestamp
       )
     ) OR (
       EXCLUDED.provider_timestamp IS NULL
       AND pending_whatsapp_reactions.provider_timestamp IS NULL
       AND EXCLUDED.updated_at >= pending_whatsapp_reactions.updated_at
     )
     RETURNING id`,
    [
      targetWhatsappMessageId,
      reactorKey,
      reactorWhatsappId,
      emoji,
      providerReactionMessageId,
      providerTimestamp,
      receivedAt,
    ]
  );
  return Boolean(result.rows[0]);
}

async function hasPendingWhatsappReactionsForTarget(
  queryable,
  targetWhatsappMessageId
) {
  const result = await queryable.query(
    `SELECT 1
     FROM pending_whatsapp_reactions
     WHERE target_whatsapp_message_id = $1
     LIMIT 1`,
    [targetWhatsappMessageId]
  );
  return Boolean(result.rows[0]);
}

async function consumePendingWhatsappReactionsForTarget(
  queryable,
  { targetWhatsappMessageId, targetMessageId, contactId }
) {
  const pendingResult = await queryable.query(
    `SELECT id, reactor_key, reactor_whatsapp_id, emoji,
            provider_reaction_message_id, provider_timestamp,
            received_at, updated_at
     FROM pending_whatsapp_reactions
     WHERE target_whatsapp_message_id = $1
     ORDER BY id ASC`,
    [targetWhatsappMessageId]
  );

  if (!pendingResult.rows.length) {
    return { hadPending: false, changed: false };
  }

  let changed = false;
  for (const pending of pendingResult.rows) {
    const applied = await upsertWhatsappReactionState(queryable, {
      targetMessageId,
      contactId,
      reactorKey: pending.reactor_key,
      emoji: pending.emoji,
      providerReactionMessageId: pending.provider_reaction_message_id,
      providerTimestamp: normalizeReactionTimestamp(pending.provider_timestamp),
      receivedAt: pending.updated_at || pending.received_at || new Date(),
    });
    changed = applied || changed;
  }

  await queryable.query(
    `DELETE FROM pending_whatsapp_reactions
     WHERE target_whatsapp_message_id = $1`,
    [targetWhatsappMessageId]
  );

  return { hadPending: true, changed };
}

async function pruneExpiredPendingWhatsappReactions(queryable) {
  await queryable.query(
    `DELETE FROM pending_whatsapp_reactions
     WHERE updated_at < NOW() - interval '35 days'`
  );
}

async function reconcilePendingWhatsappReactionsForTarget(
  queryable,
  target,
  targetWhatsappMessageId
) {
  if (!target?.id || !target?.contact_id || !targetWhatsappMessageId) return null;

  // Most outbound messages have no pending reactions. Because callers hold the
  // WAMID transaction lock, this indexed pre-check is race-safe and avoids
  // taking the heavier per-conversation lock on every normal send.
  if (
    !(await hasPendingWhatsappReactionsForTarget(
      queryable,
      targetWhatsappMessageId
    ))
  ) {
    return null;
  }

  await lockConversation(queryable, target.contact_id);

  const pending = await consumePendingWhatsappReactionsForTarget(queryable, {
    targetWhatsappMessageId,
    targetMessageId: target.id,
    contactId: target.contact_id,
  });

  if (!pending.hadPending) return null;

  const reactions = await readActiveWhatsappReactions(queryable, target.id);
  console.log(
    `[WhatsApp reaction] Reconciled pending reaction(s) for local message ${target.id}.`
  );
  return {
    contactId: target.contact_id,
    messageId: target.id,
    reactions,
    changed: pending.changed,
  };
}

/**
 * Replays reactions that arrived before a message WAMID became visible locally.
 * Business App/coexistence messages use this after their direct insert path;
 * API sends normally reconcile inside setWhatsappMessageId's WAMID-locked
 * transaction.
 */
async function reconcilePendingWhatsappReactionsForMessage(
  messageId,
  whatsappMessageId
) {
  const safeMessageId = Number(messageId);
  const targetWhatsappMessageId = String(whatsappMessageId || "").trim();
  if (
    !Number.isSafeInteger(safeMessageId) ||
    safeMessageId < 1 ||
    !targetWhatsappMessageId
  ) {
    return null;
  }

  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;

    await lockWhatsappMessageId(client, targetWhatsappMessageId);

    const targetResult = await client.query(
      `SELECT id, contact_id
       FROM messages
       WHERE id = $1
         AND whatsapp_message_id = $2
       LIMIT 1`,
      [safeMessageId, targetWhatsappMessageId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }

    const update = await reconcilePendingWhatsappReactionsForTarget(
      client,
      target,
      targetWhatsappMessageId
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return update;
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Applies a customer WhatsApp reaction to the message it references.
 *
 * Reactions deliberately live outside the messages table so they do not become
 * AI history, unread customer turns, follow-up anchors, or staff-waiting events.
 * If the target WAMID is not locally resolvable yet, the event is durably
 * queued and reconciled when the outbound message receives its WAMID.
 *
 * Reaction removals are stored as an empty-emoji tombstone. Keeping the
 * provider timestamp lets us reject a delayed older webhook instead of
 * resurrecting a reaction the customer already removed or changed.
 */
async function isDeletedWhatsappReactionEvent(
  queryable,
  { targetWhatsappMessageId, providerReactionMessageId = null } = {}
) {
  const ids = [
    String(targetWhatsappMessageId || "").trim(),
    String(providerReactionMessageId || "").trim(),
  ].filter(Boolean);
  if (!ids.length) return false;

  const result = await queryable.query(
    `SELECT EXISTS (
       SELECT 1
       FROM customer_data_deleted_message_ids
       WHERE provider_message_id = ANY($1::text[])
         AND expires_at > now()
     ) AS deleted`,
    [ids]
  );
  return result.rows[0]?.deleted === true;
}

async function applyWhatsappReaction(reaction) {
  const targetWhatsappMessageId = String(reaction?.targetMessageId || "").trim();
  const reactorWhatsappId = String(reaction?.from || "").trim();
  const providerReactionMessageId = String(reaction?.id || "").trim() || null;
  const emoji = typeof reaction?.emoji === "string" ? reaction.emoji : null;
  const providerTimestamp = normalizeReactionTimestamp(reaction?.timestamp);

  if (!targetWhatsappMessageId || !reactorWhatsappId || emoji == null) {
    return null;
  }

  const reactorKey = `whatsapp:${reactorWhatsappId}`;
  const receivedAt = new Date();
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // The target's send/echo path takes the same lock before making this WAMID
    // visible locally. Whichever transaction wins first leaves durable state
    // that the second transaction is guaranteed to observe.
    await lockWhatsappMessageId(client, targetWhatsappMessageId);

    if (await isDeletedWhatsappReactionEvent(client, {
      targetWhatsappMessageId,
      providerReactionMessageId,
    })) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }

    const target = await findWhatsappReactionTarget(
      client,
      targetWhatsappMessageId
    );

    if (!target) {
      const changed = await queuePendingWhatsappReaction(client, {
        targetWhatsappMessageId,
        reactorWhatsappId,
        reactorKey,
        emoji,
        providerReactionMessageId,
        providerTimestamp,
        receivedAt,
      });
      await pruneExpiredPendingWhatsappReactions(client);
      await client.query("COMMIT");
      transactionStarted = false;

      console.warn(
        `[WhatsApp reaction] Target ${targetWhatsappMessageId} is not available locally yet; queued reaction for reconciliation.`
      );
      return {
        pending: true,
        targetMessageId: targetWhatsappMessageId,
        changed,
      };
    }

    await lockConversation(client, target.contact_id);

    const pending = await consumePendingWhatsappReactionsForTarget(client, {
      targetWhatsappMessageId,
      targetMessageId: target.id,
      contactId: target.contact_id,
    });

    const currentChanged = await upsertWhatsappReactionState(client, {
      targetMessageId: target.id,
      contactId: target.contact_id,
      reactorKey,
      emoji,
      providerReactionMessageId,
      providerTimestamp,
      receivedAt,
    });

    const reactions = await readActiveWhatsappReactions(client, target.id);
    await pruneExpiredPendingWhatsappReactions(client);
    await client.query("COMMIT");
    transactionStarted = false;

    const changed = pending.changed || currentChanged;
    console.log(
      `[WhatsApp reaction] ${changed ? "Applied" : "Ignored stale/duplicate"} reaction for local message ${target.id}.`
    );

    return {
      contactId: target.contact_id,
      messageId: target.id,
      reactions,
      changed,
    };
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delivery webhooks only need the contact id (for failures) plus status data.
 * Never return media_base64 here. Repeated identical webhook statuses are also
 * ignored so they do not create needless writes.
 */
async function updateDeliveryStatusByWamid(whatsappMessageId, status, errorText = null) {
  const result = await pool.query(
    `UPDATE messages SET delivery_status = $2, delivery_error = $3
     WHERE whatsapp_message_id = $1
       AND (delivery_status IS DISTINCT FROM $2 OR delivery_error IS DISTINCT FROM $3)
       AND (
         $2 = 'failed'
         OR delivery_status IS NULL
         OR CASE $2
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              ELSE 0
            END >= CASE delivery_status
              WHEN 'pending' THEN 0
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              WHEN 'failed' THEN 4
              ELSE -1
            END
       )
     RETURNING id, contact_id, whatsapp_message_id, delivery_status, delivery_error`,
    [whatsappMessageId, status, errorText]
  );
  return result.rows[0] || null;
}

module.exports = {
  saveMessage,
  saveInboundMessageIfNew,
  updateInboundMessage,
  getMessagesForContact,
  wasPromoRecentlySent,
  wasPromoRecentlySentWithExecutor,
  wasMediaRecentlySent,
  wasMediaRecentlySentWithExecutor,
  getMostRecentlySentMediaUrl,
  getMostRecentlySentMediaUrlWithExecutor,
  getMessagePageForContact,
  getMessageMediaReferenceForContact,
  getMessageMediaForContact,
  setMessageMediaKeyById,
  setMessageContentById,
  getMessageForForward,
  getMessageForRetry,
  getMessageForReplyContext,
  getMessageByProviderIdForContact,
  getMessageByAnyProviderIdForContact,
  hasStaffReplyAfter,
  isDeletedWhatsappReactionEvent,
  applyWhatsappReaction,
  reconcilePendingWhatsappReactionsForMessage,
  registerSocialProviderMessageAlias,
  socialProviderAliasRecorder,
  getDeliveryStatusesForContact,
  acquireMessageRetryLock,
  deleteUnsentAssistantMessage,
  setWhatsappMessageId,
  setSocialProviderMessageId,
  setDeliveryStatusById,
  markDeliveryUnknownIfUnconfirmed,
  updateDeliveryStatusByWamid,
};