const { pool } = require("./db");
const { analyticsQuery } = require("./analyticsRepo");
const {
  getAnalyticsPipelineProfile,
  milestoneTimesCte,
} = require("./analyticsPipelineProfile");

const TIME_ZONE = "Asia/Kuala_Lumpur";
const CRM_VALUE_CURRENCY = "MYR";

const JOURNEY_BASE_CTE = `
WITH journey_window AS (
  SELECT
    l.id,
    l.contact_id,
    l.stage_id,
    l.temperature,
    l.estimated_value,
    l.appointment_status,
    l.created_at,
    l.started_message_id,
    c.channel,
    s.stage_type AS current_stage_type,
    COALESCE(start_message.created_at, l.created_at) AS journey_started_at,
    LEAD(l.started_message_id) OVER (
      PARTITION BY l.contact_id ORDER BY l.created_at ASC, l.id ASC
    ) AS next_started_message_id,
    LEAD(l.created_at) OVER (
      PARTITION BY l.contact_id ORDER BY l.created_at ASC, l.id ASC
    ) AS next_journey_created_at
  FROM leads l
  JOIN contacts c ON c.id = l.contact_id
  JOIN pipeline_stages s ON s.id = l.stage_id
  LEFT JOIN messages start_message ON start_message.id = l.started_message_id
),
journeys AS (
  SELECT * FROM journey_window
)
`;

const LEVELS = Object.freeze({
  campaign: {
    insightId: "fi.campaign_id",
    insightName: "fi.campaign_name",
    crmId: "crm.campaign_id",
    crmName: "crm.campaign_name",
  },
  adset: {
    insightId: "fi.adset_id",
    insightName: "fi.adset_name",
    crmId: "crm.adset_id",
    crmName: "crm.adset_name",
  },
  ad: {
    insightId: "fi.ad_id",
    insightName: "fi.ad_name",
    crmId: "crm.meta_ad_id",
    crmName: "crm.ad_name",
  },
});

function number(value) {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(number(value) * factor) / factor;
}

function nullableRatio(numerator, denominator, multiplier = 1, digits = 2) {
  const bottom = number(denominator);
  if (!bottom) return null;
  return rounded((number(numerator) / bottom) * multiplier, digits);
}

function percent(numerator, denominator) {
  return nullableRatio(numerator, denominator, 100, 1) ?? 0;
}

function moneyMetric(spend, denominator) {
  return nullableRatio(spend, denominator, 1, 2);
}

function periodSql(expression) {
  return `
    ${expression} >= ($1::date::timestamp AT TIME ZONE '${TIME_ZONE}')
    AND ${expression} < ((($2::date + 1)::timestamp) AT TIME ZONE '${TIME_ZONE}')
  `;
}

function normalizeCurrencyList(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function buildAnalyticsSql(level, profile) {
  const dimension = LEVELS[level];
  if (!dimension) throw new TypeError("Unsupported Meta Ads analytics level.");

  return `
    ${JOURNEY_BASE_CTE}
    ${milestoneTimesCte(profile)},
    ad_hierarchy AS (
      SELECT DISTINCT ON (ad_id)
        ad_id,
        account_id,
        account_name,
        account_currency,
        campaign_id,
        campaign_name,
        adset_id,
        adset_name,
        ad_name
      FROM meta_ad_insights_daily
      ORDER BY ad_id, insight_date DESC, updated_at DESC
    ),
    filtered_insights AS (
      SELECT *
      FROM meta_ad_insights_daily fi
      WHERE fi.insight_date >= $1::date
        AND fi.insight_date <= $2::date
        AND ($3::text IS NULL OR fi.account_id = $3)
        AND ($4::text IS NULL OR fi.campaign_id = $4)
        AND ($5::text IS NULL OR fi.adset_id = $5)
        AND ($6::text IS NULL OR fi.ad_id = $6)
    ),
    crm_source_raw AS (
      SELECT
        j.id AS lead_id,
        j.temperature,
        j.estimated_value,
        j.reached_appointment,
        j.reached_visited,
        j.reached_won,
        la.meta_ad_id,
        COALESCE(la.meta_account_id, ah.account_id) AS account_id,
        ah.account_name,
        ah.account_currency,
        COALESCE(la.campaign_id, ah.campaign_id) AS campaign_id,
        COALESCE(la.campaign_name, ah.campaign_name) AS campaign_name,
        COALESCE(la.adset_id, ah.adset_id) AS adset_id,
        COALESCE(la.adset_name, ah.adset_name) AS adset_name,
        COALESCE(la.ad_name, ah.ad_name) AS ad_name,
        EXISTS (
          SELECT 1
          FROM filtered_insights fi
          WHERE fi.ad_id = la.meta_ad_id
        ) AS matched_to_synced_ad
      FROM journeys_with_milestones j
      JOIN lead_attributions la ON la.lead_id = j.id
      LEFT JOIN ad_hierarchy ah ON ah.ad_id = la.meta_ad_id
      WHERE la.source = 'meta_ads'
        AND la.meta_ad_id IS NOT NULL
        AND ${periodSql("j.journey_started_at")}
    ),
    crm_source AS (
      SELECT *
      FROM crm_source_raw crm
      WHERE ($3::text IS NULL OR crm.account_id = $3)
        AND ($4::text IS NULL OR crm.campaign_id = $4)
        AND ($5::text IS NULL OR crm.adset_id = $5)
        AND ($6::text IS NULL OR crm.meta_ad_id = $6)
    ),
    spend_summary AS (
      SELECT
        COALESCE(SUM(spend), 0)::numeric AS spend,
        COALESCE(SUM(impressions), 0)::bigint AS impressions,
        COALESCE(SUM(clicks), 0)::bigint AS clicks,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT account_currency), NULL) AS currencies
      FROM filtered_insights
    ),
    crm_summary AS (
      SELECT
        COUNT(*)::int AS crm_leads,
        COUNT(*) FILTER (WHERE temperature = 'hot')::int AS hot_leads,
        COUNT(*) FILTER (WHERE reached_appointment)::int AS appointments,
        COUNT(*) FILTER (WHERE reached_visited)::int AS visits,
        COUNT(*) FILTER (WHERE reached_won)::int AS won,
        COALESCE(SUM(estimated_value) FILTER (WHERE reached_won), 0)::numeric AS estimated_won_value,
        COUNT(*) FILTER (WHERE matched_to_synced_ad)::int AS matched_leads
      FROM crm_source
    ),
    spend_groups AS (
      SELECT
        fi.account_id,
        (ARRAY_AGG(fi.account_name ORDER BY fi.insight_date DESC)
          FILTER (WHERE fi.account_name IS NOT NULL))[1] AS account_name,
        fi.account_currency,
        ${dimension.insightId} AS entity_id,
        (ARRAY_AGG(${dimension.insightName} ORDER BY fi.insight_date DESC)
          FILTER (WHERE ${dimension.insightName} IS NOT NULL))[1] AS entity_name,
        SUM(fi.spend)::numeric AS spend,
        SUM(fi.impressions)::bigint AS impressions,
        SUM(fi.clicks)::bigint AS clicks
      FROM filtered_insights fi
      WHERE ${dimension.insightId} IS NOT NULL
      GROUP BY fi.account_id, fi.account_currency, ${dimension.insightId}
    ),
    crm_groups AS (
      SELECT
        crm.account_id,
        MAX(crm.account_name) AS account_name,
        MAX(crm.account_currency) AS account_currency,
        ${dimension.crmId} AS entity_id,
        MAX(${dimension.crmName}) AS entity_name,
        COUNT(*)::int AS crm_leads,
        COUNT(*) FILTER (WHERE crm.temperature = 'hot')::int AS hot_leads,
        COUNT(*) FILTER (WHERE crm.reached_appointment)::int AS appointments,
        COUNT(*) FILTER (WHERE crm.reached_visited)::int AS visits,
        COUNT(*) FILTER (WHERE crm.reached_won)::int AS won,
        COALESCE(SUM(crm.estimated_value) FILTER (WHERE crm.reached_won), 0)::numeric AS estimated_won_value,
        COUNT(*) FILTER (WHERE crm.matched_to_synced_ad)::int AS matched_leads
      FROM crm_source crm
      WHERE ${dimension.crmId} IS NOT NULL
      GROUP BY crm.account_id, ${dimension.crmId}
    ),
    joined_rows AS (
      SELECT
        COALESCE(s.account_id, c.account_id) AS account_id,
        COALESCE(s.account_name, c.account_name) AS account_name,
        COALESCE(s.account_currency, c.account_currency) AS account_currency,
        COALESCE(s.entity_id, c.entity_id) AS entity_id,
        COALESCE(s.entity_name, c.entity_name) AS entity_name,
        COALESCE(s.spend, 0)::numeric AS spend,
        COALESCE(s.impressions, 0)::bigint AS impressions,
        COALESCE(s.clicks, 0)::bigint AS clicks,
        COALESCE(c.crm_leads, 0)::int AS crm_leads,
        COALESCE(c.hot_leads, 0)::int AS hot_leads,
        COALESCE(c.appointments, 0)::int AS appointments,
        COALESCE(c.visits, 0)::int AS visits,
        COALESCE(c.won, 0)::int AS won,
        COALESCE(c.estimated_won_value, 0)::numeric AS estimated_won_value,
        COALESCE(c.matched_leads, 0)::int AS matched_leads
      FROM spend_groups s
      FULL OUTER JOIN crm_groups c
        ON c.account_id IS NOT DISTINCT FROM s.account_id
       AND c.entity_id = s.entity_id
    )
    SELECT
      ss.spend,
      ss.impressions,
      ss.clicks,
      ss.currencies,
      cs.crm_leads,
      cs.hot_leads,
      cs.appointments,
      cs.visits,
      cs.won,
      cs.estimated_won_value,
      cs.matched_leads,
      COALESCE((
        SELECT json_agg(json_build_object(
          'accountId', jr.account_id,
          'accountName', jr.account_name,
          'currency', jr.account_currency,
          'id', jr.entity_id,
          'name', jr.entity_name,
          'spend', jr.spend,
          'impressions', jr.impressions,
          'clicks', jr.clicks,
          'crmLeads', jr.crm_leads,
          'hotLeads', jr.hot_leads,
          'appointments', jr.appointments,
          'visits', jr.visits,
          'won', jr.won,
          'estimatedWonValue', jr.estimated_won_value,
          'matchedLeads', jr.matched_leads
        ) ORDER BY jr.spend DESC, jr.crm_leads DESC, jr.entity_name ASC NULLS LAST)
        FROM joined_rows jr
      ), '[]'::json) AS rows
    FROM spend_summary ss
    CROSS JOIN crm_summary cs
  `;
}

function enrichPerformance(row, { allowValueRoas = false } = {}) {
  const spend = rounded(row.spend, 2);
  const impressions = number(row.impressions);
  const clicks = number(row.clicks);
  const crmLeads = number(row.crmLeads ?? row.crm_leads);
  const appointments = number(row.appointments);
  const visits = number(row.visits);
  const won = number(row.won);
  const estimatedWonValue = rounded(row.estimatedWonValue ?? row.estimated_won_value, 2);

  return {
    ...row,
    spend,
    impressions,
    clicks,
    crmLeads,
    hotLeads: number(row.hotLeads ?? row.hot_leads),
    appointments,
    visits,
    won,
    estimatedWonValue,
    ctr: nullableRatio(clicks, impressions, 100, 2),
    cpc: moneyMetric(spend, clicks),
    cpm: nullableRatio(spend, impressions, 1000, 2),
    leadToAppointmentRate: percent(appointments, crmLeads),
    leadToWonRate: percent(won, crmLeads),
    costPerLead: moneyMetric(spend, crmLeads),
    costPerAppointment: moneyMetric(spend, appointments),
    costPerVisit: moneyMetric(spend, visits),
    costPerWon: moneyMetric(spend, won),
    estimatedRoas: allowValueRoas ? nullableRatio(estimatedWonValue, spend, 1, 2) : null,
  };
}

async function getMetaAdsAnalytics(filters, { database = pool, analyticsProfile = null } = {}) {
  const profile = analyticsProfile || getAnalyticsPipelineProfile();
  const query = database === pool
    ? analyticsQuery
    : (text, params) => database.query(text, params);
  const result = await query(
    buildAnalyticsSql(filters.level, profile),
    [
      filters.from,
      filters.to,
      filters.accountId || null,
      filters.campaignId || null,
      filters.adsetId || null,
      filters.adId || null,
    ]
  );

  const raw = result.rows[0] || {};
  const currencies = normalizeCurrencyList(raw.currencies);
  const mixedCurrency = currencies.length > 1;
  const currency = currencies.length === 1 ? currencies[0] : null;
  const allowMoneyMetrics = !mixedCurrency && Boolean(currency);

  const accountResult = await query(
    `WITH account_ids AS (
       SELECT account_id FROM meta_ads_insights_sync_state
       UNION
       SELECT DISTINCT account_id FROM meta_ad_insights_daily
     )
     SELECT
       ids.account_id,
       latest.account_name,
       latest.account_currency,
       latest.insight_date::text AS data_through,
       ss.last_attempt_at,
       ss.last_success_at,
       ss.last_error,
       ss.last_backfill_completed_at,
       ss.backfill_next_date,
       ss.coverage_start_date::text AS coverage_start_date,
       ss.coverage_end_date::text AS coverage_end_date,
       ss.lease_until
     FROM account_ids ids
     LEFT JOIN meta_ads_insights_sync_state ss
       ON ss.account_id = ids.account_id
     LEFT JOIN LATERAL (
       SELECT
         mi.account_name,
         mi.account_currency,
         mi.insight_date
       FROM meta_ad_insights_daily mi
       WHERE mi.account_id = ids.account_id
       ORDER BY mi.insight_date DESC, mi.updated_at DESC
       LIMIT 1
     ) latest ON true
     ORDER BY latest.account_name NULLS LAST, ids.account_id`
  );

  const accounts = accountResult.rows.map((row) => ({
    accountId: row.account_id,
    accountName: row.account_name || null,
    currency: row.account_currency || null,
    dataThrough: row.data_through || null,
    coverageFrom: row.coverage_start_date || null,
    coverageThrough: row.coverage_end_date || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastError: row.last_error || null,
    backfillCompletedAt: row.last_backfill_completed_at || null,
    backfillNextDate: row.backfill_next_date || null,
    syncing: Boolean(row.lease_until && new Date(row.lease_until).getTime() > Date.now()),
  }));
  const accountById = new Map(accounts.map((account) => [String(account.accountId), account]));
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];

  const rowAccountIds = rawRows
    .map((row) => row.accountId)
    .filter(Boolean)
    .map(String);
  const relevantAccountIds = [...new Set(
    filters.accountId
      ? [String(filters.accountId)]
      : rowAccountIds.length
        ? rowAccountIds
        : accounts.map((account) => String(account.accountId))
  )];

  const accountCoversRange = (accountId) => {
    const account = accountById.get(String(accountId));
    return Boolean(
      account?.coverageFrom
      && account?.coverageThrough
      && account.coverageFrom <= filters.from
      && account.coverageThrough >= filters.to
    );
  };
  const uncoveredAccountIds = relevantAccountIds.filter(
    (accountId) => !accountCoversRange(accountId)
  );
  const historyComplete = uncoveredAccountIds.length === 0;
  const coverageStarts = relevantAccountIds
    .map((accountId) => accountById.get(accountId)?.coverageFrom)
    .filter(Boolean);
  const coverageEnds = relevantAccountIds
    .map((accountId) => accountById.get(accountId)?.coverageThrough)
    .filter(Boolean);
  const commonCoverageFrom = coverageStarts.length
    ? [...coverageStarts].sort().at(-1)
    : null;
  const commonCoverageThrough = coverageEnds.length
    ? [...coverageEnds].sort()[0]
    : null;

  const matchedLeads = number(raw.matched_leads);
  const crmLeads = number(raw.crm_leads);
  const attributionComplete = matchedLeads === crmLeads;
  const spendCoverageComplete = historyComplete && attributionComplete;
  const allowValueRoas = (
    allowMoneyMetrics
    && currency === CRM_VALUE_CURRENCY
    && spendCoverageComplete
  );

  const summary = enrichPerformance({
    spend: raw.spend,
    impressions: raw.impressions,
    clicks: raw.clicks,
    crmLeads,
    hotLeads: raw.hot_leads,
    appointments: raw.appointments,
    visits: raw.visits,
    won: raw.won,
    estimatedWonValue: raw.estimated_won_value,
  }, { allowValueRoas });

  if (!allowMoneyMetrics) {
    summary.spend = null;
    summary.cpc = null;
    summary.cpm = null;
  }
  if (!allowMoneyMetrics || !spendCoverageComplete) {
    summary.costPerLead = null;
    summary.costPerAppointment = null;
    summary.costPerVisit = null;
    summary.costPerWon = null;
    summary.estimatedRoas = null;
  }

  const rows = rawRows.map((entry) => {
    const rowCurrency = entry.currency || null;
    const rowCrmLeads = number(entry.crmLeads);
    const rowMatchedLeads = number(entry.matchedLeads);
    const rowAttributionComplete = rowMatchedLeads === rowCrmLeads;
    const rowHistoryComplete = Boolean(entry.accountId && accountCoversRange(entry.accountId));
    const rowCoverageComplete = rowHistoryComplete && rowAttributionComplete;
    const enriched = enrichPerformance(entry, {
      allowValueRoas: rowCurrency === CRM_VALUE_CURRENCY && rowCoverageComplete,
    });
    enriched.spendCoverageComplete = rowCoverageComplete;
    if (!rowCurrency) {
      enriched.cpc = null;
      enriched.cpm = null;
    }
    if (!rowCurrency || !rowCoverageComplete) {
      enriched.costPerLead = null;
      enriched.costPerAppointment = null;
      enriched.costPerVisit = null;
      enriched.costPerWon = null;
      enriched.estimatedRoas = null;
    }
    return enriched;
  });

  return {
    range: {
      from: filters.from,
      to: filters.to,
      dayCount: filters.dayCount,
      timeZone: filters.timeZone,
    },
    level: filters.level,
    filters: {
      accountId: filters.accountId,
      campaignId: filters.campaignId,
      adsetId: filters.adsetId,
      adId: filters.adId,
    },
    money: {
      currency,
      currencies,
      mixedCurrency,
      crmValueCurrency: CRM_VALUE_CURRENCY,
      estimatedRoasAvailable: allowValueRoas,
    },
    summary,
    attributionCoverage: {
      metaAttributedLeads: crmLeads,
      matchedToSyncedAds: matchedLeads,
      unmatchedToSyncedAds: Math.max(0, crmLeads - matchedLeads),
      matchedRate: percent(matchedLeads, crmLeads),
    },
    spendCoverage: {
      complete: spendCoverageComplete,
      historyComplete,
      attributionComplete,
      relevantAccountIds,
      uncoveredAccountIds,
      coverageFrom: commonCoverageFrom,
      coverageThrough: commonCoverageThrough,
    },
    rows,
    accounts,
  };
}

module.exports = {
  CRM_VALUE_CURRENCY,
  LEVELS,
  buildAnalyticsSql,
  enrichPerformance,
  getMetaAdsAnalytics,
  nullableRatio,
};
