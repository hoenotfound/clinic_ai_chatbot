const { pool } = require("./db");

const SOCIAL_CHANNELS = new Set(["facebook", "instagram"]);

async function recordOutboundAccepted(channel, at = new Date(), queryable = pool) {
  if (!SOCIAL_CHANNELS.has(channel)) return false;

  await queryable.query(
    `INSERT INTO messaging_runtime_health (
       channel, last_outbound_accepted_at, updated_at
     )
     VALUES ($1, $2, NOW())
     ON CONFLICT (channel) DO UPDATE SET
       last_outbound_accepted_at = GREATEST(
         COALESCE(messaging_runtime_health.last_outbound_accepted_at, '-infinity'::timestamptz),
         EXCLUDED.last_outbound_accepted_at
       ),
       updated_at = NOW()`,
    [channel, at]
  );
  return true;
}

async function listRuntimeHealth(queryable = pool) {
  const result = await queryable.query(
    `SELECT channel, last_outbound_accepted_at
     FROM messaging_runtime_health
     WHERE channel IN ('facebook', 'instagram')
     ORDER BY channel`
  );
  return result.rows;
}

module.exports = {
  listRuntimeHealth,
  recordOutboundAccepted,
};
