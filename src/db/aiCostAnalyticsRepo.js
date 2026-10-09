const { pool } = require("./db");

// AI usage is counted on the MYT day the provider call happened. A "new lead"
// is a newly created CRM contact on that day, not a distinct follow-up recipient.
// Non-admin views are restricted to their accessible contacts in every query.
async function getAiCostAnalytics({
  days = 7,
  accessibleContactIds = null,
  accessibleLeadIds = null,
  database = pool,
  fxRate = process.env.AI_USD_MYR_RATE,
} = {}) {
  const safeDays = Math.min(30, Math.max(1, Number.isInteger(Number(days)) ? Number(days) : 7));
  const scope = accessibleContactIds === null ? null :
    (Array.isArray(accessibleContactIds) ? accessibleContactIds.filter(Number.isSafeInteger) : []);
  const leadScope = accessibleLeadIds === null ? null :
    (Array.isArray(accessibleLeadIds) ? accessibleLeadIds.filter(Number.isSafeInteger) : []);
  const params = [safeDays, scope, leadScope];
  const dateRange = String.raw`(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - ($1::int - 1)`;
  const events = String.raw`FROM ai_usage_events e
      WHERE (e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${dateRange}
        AND ($2::int[] IS NULL OR e.contact_id = ANY($2::int[]))`;

  const [dailyResult, categoryResult, leadResult, cacheResult, journeyResult, leadSummaryResult] = await Promise.all([
    database.query(
      `WITH calendar AS (
        SELECT generate_series(${dateRange},
          (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, interval '1 day')::date AS day
      ), daily_usage AS (
        SELECT (e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
          COUNT(*)::int AS calls,
          COUNT(*) FILTER (WHERE e.estimated_cost_usd IS NOT NULL)::int AS priced_calls,
          COUNT(*) FILTER (WHERE e.estimated_cost_usd IS NULL)::int AS unpriced_calls,
          COUNT(*) FILTER (WHERE e.contact_id IS NULL)::int AS unattributed_calls,
          COALESCE(SUM(e.estimated_cost_usd),0)::numeric AS usd,
          COUNT(DISTINCT e.lead_id) FILTER (
            WHERE e.estimated_cost_usd IS NOT NULL
              AND ($3::int[] IS NULL OR e.lead_id = ANY($3::int[]))
          )::int AS priced_active_leads,
          COALESCE(SUM(e.estimated_cost_usd) FILTER (
            WHERE e.lead_id IS NOT NULL
              AND ($3::int[] IS NULL OR e.lead_id = ANY($3::int[]))
          ), 0)::numeric AS attributed_usd
        ${events} GROUP BY 1
      ), new_contacts AS (
        SELECT (c.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS day,
          COUNT(*)::int AS new_leads
        FROM contacts c
        WHERE (c.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${dateRange}
          AND ($2::int[] IS NULL OR c.id = ANY($2::int[]))
        GROUP BY 1
      )
      SELECT calendar.day::text, COALESCE(daily_usage.calls,0)::int AS calls,
        COALESCE(daily_usage.priced_calls,0)::int AS priced_calls,
        COALESCE(daily_usage.unpriced_calls,0)::int AS unpriced_calls,
        COALESCE(daily_usage.unattributed_calls,0)::int AS unattributed_calls,
        COALESCE(daily_usage.usd,0)::numeric AS usd,
        COALESCE(daily_usage.priced_active_leads,0)::int AS priced_active_leads,
        COALESCE(daily_usage.attributed_usd,0)::numeric AS attributed_usd,
        COALESCE(new_contacts.new_leads,0)::int AS new_leads
      FROM calendar LEFT JOIN daily_usage USING(day)
      LEFT JOIN new_contacts USING(day) ORDER BY calendar.day`,
      params
    ),
    database.query(
      `SELECT e.provider, e.purpose, COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE e.estimated_cost_usd IS NULL)::int AS unpriced_calls,
        COALESCE(SUM(e.estimated_cost_usd),0)::numeric AS usd,
        COALESCE(SUM(e.prompt_tokens),0)::bigint AS prompt_tokens,
        COALESCE(SUM(e.cached_tokens),0)::bigint AS cached_tokens
      ${events} GROUP BY e.provider,e.purpose ORDER BY usd DESC`,
      params.slice(0, 2)
    ),
    database.query(
      `SELECT e.contact_id, c.channel, COUNT(*)::int AS calls,
        COALESCE(SUM(e.estimated_cost_usd),0)::numeric AS usd,
        COUNT(*) FILTER (WHERE e.estimated_cost_usd IS NULL)::int AS unpriced_calls
      FROM ai_usage_events e
      JOIN contacts c ON c.id=e.contact_id
      WHERE (e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${dateRange}
        AND ($2::int[] IS NULL OR e.contact_id = ANY($2::int[]))
      GROUP BY e.contact_id,c.channel ORDER BY usd DESC LIMIT 30`,
      params.slice(0, 2)
    ),
    database.query(
      `SELECT e.model, e.purpose,
        COUNT(*) FILTER(WHERE e.status='success')::int AS successful_calls,
        COUNT(*) FILTER(WHERE e.status='success' AND e.prompt_tokens < 4096)::int AS below_4096,
        COUNT(*) FILTER(WHERE e.status='success' AND e.prompt_tokens >= 4096)::int AS at_least_4096,
        COUNT(*) FILTER(WHERE e.status='success' AND e.cached_tokens > 0)::int AS cache_hits,
        COUNT(*) FILTER(WHERE e.status='success' AND e.cache_metadata_present IS FALSE)::int AS cache_metadata_missing,
        COUNT(DISTINCT e.prompt_prefix_hash)::int AS distinct_prefixes,
        COALESCE(ROUND(AVG(e.prompt_tokens) FILTER(WHERE e.status='success')),0)::int AS mean_prompt_tokens
      ${events}
      AND e.provider = 'gemini'
      AND e.model IN ('gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash')
      AND e.purpose IN ('customer_reply','follow_up_generation')
      GROUP BY e.model,e.purpose ORDER BY e.purpose,e.model`,
      params.slice(0, 2)
    ),
    database.query(
      `SELECT e.lead_id, e.contact_id, COUNT(*)::int AS calls,
        COALESCE(SUM(e.estimated_cost_usd),0)::numeric AS usd,
        COUNT(*) FILTER (WHERE e.estimated_cost_usd IS NULL)::int AS unpriced_calls
      FROM ai_usage_events e
      JOIN leads l ON l.id=e.lead_id AND l.contact_id=e.contact_id
      WHERE (e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${dateRange}
        AND ($2::int[] IS NULL OR e.contact_id = ANY($2::int[]))
        AND ($3::int[] IS NULL OR e.lead_id = ANY($3::int[]))
      GROUP BY e.lead_id,e.contact_id ORDER BY usd DESC LIMIT 30`,
      params
    ),
    database.query(
      `SELECT
        COUNT(DISTINCT e.lead_id) FILTER (WHERE e.estimated_cost_usd IS NOT NULL)::int AS priced_leads,
        COALESCE(SUM(e.estimated_cost_usd),0)::numeric AS attributed_usd,
        COUNT(*) FILTER (WHERE e.estimated_cost_usd IS NULL)::int AS unpriced_calls
      FROM ai_usage_events e
      JOIN leads l ON l.id = e.lead_id AND l.contact_id = e.contact_id
      WHERE (e.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date >= ${dateRange}
        AND ($2::int[] IS NULL OR e.contact_id = ANY($2::int[]))
        AND ($3::int[] IS NULL OR e.lead_id = ANY($3::int[]))`,
      params
    ),
  ]);

  const rate = Number(fxRate);
  const usdToMyr = fxRate != null && fxRate !== "" && Number.isFinite(rate) && rate > 0 && rate < 10
    ? rate : null;
  const daily = dailyResult.rows.map((row) => ({
    day: row.day,
    calls: Number(row.calls),
    pricedCalls: Number(row.priced_calls),
    unpricedCalls: Number(row.unpriced_calls),
    unattributedCalls: Number(row.unattributed_calls),
    newLeads: Number(row.new_leads),
    estimatedUsd: Number(row.usd),
    estimatedMyr: usdToMyr == null ? null : Number(row.usd) * usdToMyr,
    pricedActiveLeads: Number(row.priced_active_leads),
    attributedUsd: Number(row.attributed_usd),
    attributedMyr: usdToMyr == null ? null : Number(row.attributed_usd) * usdToMyr,
    usdPerActiveLead: Number(row.priced_active_leads)
      ? Number(row.attributed_usd) / Number(row.priced_active_leads) : null,
  }));
  return {
    days: safeDays,
    timeZone: "Asia/Kuala_Lumpur",
    currency: usdToMyr ? "MYR" : "USD",
    usdToMyr,
    historicalAttributionNote:
      "Historical Gemini events are estimated from recorded tokens without inferring contact or lead identity. Unknown usage remains unpriced.",
    daily,
    leadSummary: {
      pricedLeads: Number(leadSummaryResult.rows[0]?.priced_leads || 0),
      attributedUsd: Number(leadSummaryResult.rows[0]?.attributed_usd || 0),
      attributedMyr: usdToMyr == null ? null
        : Number(leadSummaryResult.rows[0]?.attributed_usd || 0) * usdToMyr,
      unpricedCalls: Number(leadSummaryResult.rows[0]?.unpriced_calls || 0),
    },
    byCategory: categoryResult.rows.map((row) => ({
      provider: row.provider, purpose: row.purpose, calls: Number(row.calls),
      unpricedCalls: Number(row.unpriced_calls),
      estimatedUsd: Number(row.usd),
      estimatedMyr: usdToMyr == null ? null : Number(row.usd) * usdToMyr,
      promptTokens: Number(row.prompt_tokens), cachedTokens: Number(row.cached_tokens),
    })),
    byContact: leadResult.rows.map((row) => ({
      contactId: Number(row.contact_id), channel: row.channel,
      calls: Number(row.calls), estimatedUsd: Number(row.usd),
      estimatedMyr: usdToMyr == null ? null : Number(row.usd) * usdToMyr,
      unpricedCalls: Number(row.unpriced_calls),
    })),
    byLead: journeyResult.rows.map((row) => ({
      leadId: Number(row.lead_id), contactId: Number(row.contact_id),
      calls: Number(row.calls), estimatedUsd: Number(row.usd),
      estimatedMyr: usdToMyr == null ? null : Number(row.usd) * usdToMyr,
      unpricedCalls: Number(row.unpriced_calls),
    })),
    cacheDiagnostics: cacheResult.rows.map((row) => ({
      model: row.model, purpose: row.purpose, successfulCalls: Number(row.successful_calls),
      below4096: Number(row.below_4096), atLeast4096: Number(row.at_least_4096),
      cacheHits: Number(row.cache_hits), cacheMetadataMissing: Number(row.cache_metadata_missing),
      distinctPrefixes: Number(row.distinct_prefixes), meanPromptTokens: Number(row.mean_prompt_tokens),
    })),
  };
}

module.exports = { getAiCostAnalytics };
