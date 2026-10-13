// Suppress replays of the exact R2 video across staff, regular FU and extended
// WhatsApp template sends. Accepted, pending and uncertain sends count as used.
async function previouslySentVideo({
  database, contactId, mediaKey, excludeMessageId = null,
} = {}) {
  if (!database || !Number.isSafeInteger(Number(contactId)) ||
      Number(contactId) < 1 || !String(mediaKey || "").trim()) return false;
  const result = await database.query(
    `SELECT 1 FROM messages
     WHERE contact_id = $1
       AND role = 'assistant'
       AND media_key = $2
       AND created_at >= now() - interval '7 days'
       AND delivery_status IS DISTINCT FROM 'failed'
       AND delivery_status IS DISTINCT FROM 'cancelled'
       AND ($3::integer IS NULL OR id <> $3::integer)
     LIMIT 1`,
    [Number(contactId), String(mediaKey).trim(), excludeMessageId]
  );
  return result.rows.length > 0;
}

module.exports = { previouslySentVideo };
