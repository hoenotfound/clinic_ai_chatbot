const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const mediaStorage = require("../services/mediaStorageService");

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
  is_automated_follow_up
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
    ),
    '[]'::jsonb
  ) AS reactions
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
  const mediaKey = await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId);
  const whatsappTemplate = options?.whatsappTemplate || null;
  const initialDeliveryStatus = options?.initialDeliveryStatus || null;
  const initialDeliveryError = options?.initialDeliveryError || null;

  if (!whatsappTemplate) {
    const result = await pool.query(
      `WITH conversation_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
       )
       INSERT INTO messages (
         contact_id, role, content, whatsapp_message_id, sent_by_username,
         media_url, media_key, media_mime_type
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
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
       delivery_status, delivery_error
     )
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
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
              ${PORTAL_REACTIONS_COLUMN}
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
            ${PORTAL_REACTIONS_COLUMN}
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

// Retry needs the original stored attachment bytes. This is deliberately a
// single-message lookup and is only used by the authenticated retry route;
// normal Inbox payloads remain lightweight and never include base64 media.
async function getMessageForRetry(contactId, messageId) {
  const result = await pool.query(
    `SELECT m.id, m.contact_id, m.role, m.content, m.whatsapp_message_id,
            m.sent_by_username, m.media_url, m.media_key, m.media_mime_type,
            m.created_at, m.delivery_status, m.delivery_error,
            m.is_automated_follow_up, m.whatsapp_template,
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
  delete row.media_key;
  row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  return row;
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
    `SELECT id, whatsapp_message_id, delivery_status, delivery_error
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
  if (!whatsappMessageId) return null;
  const result = await pool.query(
    `UPDATE messages
     SET whatsapp_message_id = $2, delivery_status = 'pending', delivery_error = NULL
     WHERE id = $1
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, whatsappMessageId]
  );
  return result.rows[0] || null;
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

/**
 * Applies a customer WhatsApp reaction to the message it references.
 *
 * Reactions deliberately live outside the messages table so they do not become
 * AI history, unread customer turns, follow-up anchors, or staff-waiting events.
 * Repeating the same webhook is idempotent, and an empty emoji removes the
 * customer's current reaction as specified by WhatsApp.
 */
async function applyWhatsappReaction(reaction) {
  const targetWhatsappMessageId = String(reaction?.targetMessageId || "").trim();
  const reactorWhatsappId = String(reaction?.from || "").trim();
  const providerReactionMessageId = String(reaction?.id || "").trim() || null;
  const emoji = typeof reaction?.emoji === "string" ? reaction.emoji : null;

  if (!targetWhatsappMessageId || !reactorWhatsappId || emoji == null) {
    return null;
  }

  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const targetResult = await client.query(
      `SELECT id, contact_id
       FROM messages
       WHERE whatsapp_message_id = $1
       LIMIT 1`,
      [targetWhatsappMessageId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,
      [target.contact_id]
    );

    const reactorKey = `whatsapp:${reactorWhatsappId}`;
    if (emoji) {
      await client.query(
        `INSERT INTO message_reactions (
           target_message_id,
           contact_id,
           reactor_key,
           emoji,
           provider_reaction_message_id
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (target_message_id, reactor_key)
         DO UPDATE SET
           emoji = EXCLUDED.emoji,
           provider_reaction_message_id = EXCLUDED.provider_reaction_message_id,
           updated_at = NOW()`,
        [
          target.id,
          target.contact_id,
          reactorKey,
          emoji,
          providerReactionMessageId,
        ]
      );
    } else {
      await client.query(
        `DELETE FROM message_reactions
         WHERE target_message_id = $1
           AND reactor_key = $2`,
        [target.id, reactorKey]
      );
    }

    const reactionResult = await client.query(
      `SELECT COALESCE(
         jsonb_agg(jsonb_build_object('emoji', emoji) ORDER BY id),
         '[]'::jsonb
       ) AS reactions
       FROM message_reactions
       WHERE target_message_id = $1`,
      [target.id]
    );

    await client.query("COMMIT");
    transactionStarted = false;
    return {
      contactId: target.contact_id,
      messageId: target.id,
      reactions: reactionResult.rows[0]?.reactions || [],
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
  getMessageForRetry,
  getMessageByProviderIdForContact,
  getMessageByAnyProviderIdForContact,
  hasStaffReplyAfter,
  applyWhatsappReaction,
  registerSocialProviderMessageAlias,
  socialProviderAliasRecorder,
  getDeliveryStatusesForContact,
  acquireMessageRetryLock,
  deleteUnsentAssistantMessage,
  setWhatsappMessageId,
  setSocialProviderMessageId,
  setDeliveryStatusById,
  updateDeliveryStatusByWamid,
};