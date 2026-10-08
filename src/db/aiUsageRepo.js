const { pool } = require("./db");

function safeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

async function recordAiUsage(event, database = pool) {
  const provider = String(event?.provider || "unknown").slice(0, 40);
  const model = String(event?.model || "unknown").slice(0, 120);
  const purpose = String(event?.purpose || "unknown").slice(0, 80);
  const status = event?.status === "success" ? "success" : "failed";
  const failureKind = event?.failureKind
    ? String(event.failureKind).slice(0, 120)
    : null;
  const cacheMetadataPresent = typeof event?.cacheMetadataPresent === "boolean"
    ? event.cacheMetadataPresent : null;
  const prefixCandidate = String(event?.promptPrefixHash || "");
  const promptPrefixHash = /^[a-f0-9]{16}$/.test(prefixCandidate) ? prefixCandidate : null;
  const latencyMs = event?.latencyMs == null
    ? null
    : Math.max(0, Math.min(3_600_000, Math.round(Number(event.latencyMs) || 0)));

  await database.query(
    `INSERT INTO ai_usage_events (
       provider,
       model,
       purpose,
       status,
       failure_kind,
       prompt_tokens,
       output_tokens,
       thinking_tokens,
       cached_tokens,
       total_tokens,
       latency_ms,
       cache_metadata_present,
       prompt_prefix_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      provider,
      model,
      purpose,
      status,
      failureKind,
      safeCount(event?.promptTokens),
      safeCount(event?.outputTokens),
      safeCount(event?.thinkingTokens),
      safeCount(event?.cachedTokens),
      safeCount(event?.totalTokens),
      latencyMs,
      cacheMetadataPresent,
      promptPrefixHash,
    ]
  );
}

async function getAiUsageSummary(database = pool, { hours = 24 } = {}) {
  const windowHours = Math.max(1, Math.min(24 * 30, Math.round(Number(hours) || 24)));
  const params = [windowHours];
  const windowSql = "created_at >= now() - ($1::int * interval '1 hour')";

  const [totalsResult, modelResult, purposeResult, failureResult] = await Promise.all([
    database.query(
      `SELECT
         COUNT(*)::int AS requests,
         COUNT(*) FILTER (WHERE status = 'success')::int AS successful_requests,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_requests,
         COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
         COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
         COALESCE(SUM(thinking_tokens), 0)::bigint AS thinking_tokens,
         COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
         COUNT(*) FILTER (WHERE status = 'success' AND cache_metadata_present IS TRUE)::int AS cache_metadata_present_requests,
         COUNT(*) FILTER (WHERE status = 'success' AND cache_metadata_present IS FALSE)::int AS cache_metadata_missing_requests,
         COUNT(*) FILTER (WHERE status = 'success' AND cache_metadata_present IS NULL)::int AS cache_metadata_unknown_requests,
         COUNT(*) FILTER (WHERE status = 'success' AND cached_tokens > 0)::int AS cache_hit_requests,
         COUNT(DISTINCT prompt_prefix_hash) FILTER (WHERE status = 'success')::int AS distinct_prompt_prefixes,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
         COALESCE(ROUND(AVG(latency_ms) FILTER (WHERE latency_ms IS NOT NULL)), 0)::bigint AS average_latency_ms
       FROM ai_usage_events
       WHERE ${windowSql}`,
      params
    ),
    database.query(
      `SELECT
         provider,
         model,
         COUNT(*)::int AS requests,
         COUNT(*) FILTER (WHERE status = 'success')::int AS successful_requests,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_requests,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
       FROM ai_usage_events
       WHERE ${windowSql}
       GROUP BY provider, model
       ORDER BY COALESCE(SUM(total_tokens), 0) DESC, COUNT(*) DESC, provider, model`,
      params
    ),
    database.query(
      `SELECT
         purpose,
         COUNT(*)::int AS requests,
         COUNT(*) FILTER (WHERE status = 'success')::int AS successful_requests,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_requests,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
       FROM ai_usage_events
       WHERE ${windowSql}
       GROUP BY purpose
       ORDER BY COALESCE(SUM(total_tokens), 0) DESC, COUNT(*) DESC, purpose`,
      params
    ),
    database.query(
      `SELECT
         COALESCE(failure_kind, 'unknown') AS failure_kind,
         COUNT(*)::int AS requests
       FROM ai_usage_events
       WHERE ${windowSql} AND status = 'failed'
       GROUP BY COALESCE(failure_kind, 'unknown')
       ORDER BY COUNT(*) DESC, COALESCE(failure_kind, 'unknown')`,
      params
    ),
  ]);

  const totals = totalsResult.rows[0] || {};
  const numeric = (value) => Number(value) || 0;

  return {
    windowHours,
    requests: numeric(totals.requests),
    successfulRequests: numeric(totals.successful_requests),
    failedRequests: numeric(totals.failed_requests),
    promptTokens: numeric(totals.prompt_tokens),
    outputTokens: numeric(totals.output_tokens),
    thinkingTokens: numeric(totals.thinking_tokens),
    cachedTokens: numeric(totals.cached_tokens),
    cacheMetadataPresentRequests: numeric(totals.cache_metadata_present_requests),
    cacheMetadataMissingRequests: numeric(totals.cache_metadata_missing_requests),
    cacheMetadataUnknownRequests: numeric(totals.cache_metadata_unknown_requests),
    cacheHitRequests: numeric(totals.cache_hit_requests),
    distinctPromptPrefixes: numeric(totals.distinct_prompt_prefixes),
    totalTokens: numeric(totals.total_tokens),
    averageLatencyMs: numeric(totals.average_latency_ms),
    byModel: modelResult.rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      requests: numeric(row.requests),
      successfulRequests: numeric(row.successful_requests),
      failedRequests: numeric(row.failed_requests),
      totalTokens: numeric(row.total_tokens),
    })),
    byPurpose: purposeResult.rows.map((row) => ({
      purpose: row.purpose,
      requests: numeric(row.requests),
      successfulRequests: numeric(row.successful_requests),
      failedRequests: numeric(row.failed_requests),
      totalTokens: numeric(row.total_tokens),
    })),
    failuresByKind: failureResult.rows.map((row) => ({
      failureKind: row.failure_kind,
      requests: numeric(row.requests),
    })),
  };
}

module.exports = {
  getAiUsageSummary,
  recordAiUsage,
};
