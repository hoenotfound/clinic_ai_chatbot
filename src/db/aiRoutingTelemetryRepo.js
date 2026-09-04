const { pool } = require("./db");

const EVENT_TYPES = new Set([
  "gemini_model_fallback",
  "claude_fallback",
  "ai_failure",
]);

async function recordRoutingEvent(
  { eventType, provider = null, model = null, at = new Date() },
  queryable = pool
) {
  if (!EVENT_TYPES.has(eventType)) return;
  const safeProvider = ["gemini", "claude"].includes(provider) ? provider : null;
  const safeModel = model == null ? null : String(model).slice(0, 120);
  await queryable.query(
    `INSERT INTO ai_routing_events (event_type, provider, model, created_at)
     VALUES ($1, $2, $3, $4)`,
    [eventType, safeProvider, safeModel, at]
  );
}

async function getRoutingSummary({ hours = 24 } = {}, queryable = pool) {
  const safeHours = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
  const result = await queryable.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_type = 'gemini_model_fallback')::int AS gemini_model_fallbacks,
       COUNT(*) FILTER (WHERE event_type = 'claude_fallback')::int AS claude_fallbacks,
       COUNT(*) FILTER (WHERE event_type = 'ai_failure')::int AS ai_failures,
       MAX(created_at) FILTER (WHERE event_type = 'ai_failure') AS last_ai_failure_at
     FROM ai_routing_events
     WHERE created_at >= NOW() - ($1::int * interval '1 hour')`,
    [safeHours]
  );
  const row = result.rows[0] || {};
  return {
    windowHours: safeHours,
    geminiModelFallbacks: Number(row.gemini_model_fallbacks) || 0,
    claudeFallbacks: Number(row.claude_fallbacks) || 0,
    aiFailures: Number(row.ai_failures) || 0,
    lastAiFailureAt: row.last_ai_failure_at || null,
  };
}

module.exports = {
  EVENT_TYPES,
  getRoutingSummary,
  recordRoutingEvent,
};
