const { pool } = require("./db");

/**
 * A follow-up settings video is a shared R2 object. Past Inbox messages may
 * still reference it after staff replaces the configured video. The cleanup
 * worker must retain those references so preview and Retry keep working.
 *
 * A failed query must abort pruning rather than risk deleting live media.
 */
async function listReferencedFollowUpConfigVideoKeys({ database = pool } = {}) {
  const result = await database.query(
    `SELECT DISTINCT media_key
     FROM messages
     WHERE media_key IS NOT NULL
       AND (
         media_key LIKE 'clients/%/messages/follow-up-config/%'
         OR media_key LIKE 'messages/follow-up-config/%'
       )`
  );
  return result.rows
    .map((row) => String(row.media_key || "").trim())
    .filter(Boolean);
}

module.exports = { listReferencedFollowUpConfigVideoKeys };
