const { pool } = require("./db");

/**
 * Returns the earliest time any pending Meta attribution is eligible for an
 * enrichment attempt. This lets the worker sleep until real work is due rather
 * than periodically waking Postgres just to discover an empty queue.
 */
async function getNextMetaEnrichmentDueAt(query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT MIN(COALESCE(enrichment_next_attempt_at, now())) AS due_at
     FROM lead_attributions
     WHERE enrichment_status = 'pending'
       AND meta_ad_id IS NOT NULL`
  );
  return result.rows[0]?.due_at || null;
}

module.exports = { getNextMetaEnrichmentDueAt };
