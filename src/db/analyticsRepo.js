const { pool } = require("./db");

const TIME_ZONE = "Asia/Kuala_Lumpur";

const JOURNEY_CTE = `
WITH journey_window AS (
  SELECT
    l.id,
    l.contact_id,
    l.stage_id,
    l.temperature,
    l.branch_name,
    l.owner_username,
    l.treatment_interest,
    l.estimated_value,
    l.source,
    l.campaign_name,
    l.appointment_status,
    l.appointment_at,
    l.lost_reason,
    l.is_closed,
    l.created_at,
    l.closed_at,
    l.started_message_id,
    c.channel,
    s.stage_type AS current_stage_type,
    s.system_key AS current_system_key,
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

const FILTER_SQL = `
  ($3::text IS NULL OR j.branch_name = $3)
  AND ($4::text IS NULL OR j.channel = $4)
  AND ($5::text IS NULL OR j.source = $5)
  AND ($6::text IS NULL OR j.treatment_interest = $6)
  AND ($7::text IS NULL OR j.owner_username = $7)
  AND ($8::text IS NULL OR j.campaign_name = $8)
`;

const COHORT_DATE_SQL = `
  j.journey_started_at >= ($1::date::timestamp AT TIME ZONE '${TIME_ZONE}')
  AND j.journey_started_at < (($2::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')
`;

const ACTIVITY_DATE_SQL = (expression) => `
  ${expression} >= ($1::date::timestamp AT TIME ZONE '${TIME_ZONE}')
  AND ${expression} < (($2::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')
`;

function queryParams(filters, from = filters.from, to = filters.to) {
  return [
    from,
    to,
    filters.branch || null,
    filters.channel || null,
    filters.source || null,
    filters.treatment || null,
    filters.owner || null,
    filters.campaign || null,
  ];
}

function number(value) {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rounded(value, digits = 1) {
  const parsed = number(value);
  const factor = 10 ** digits;
  return Math.round(parsed * factor) / factor;
}

function percent(numerator, denominator) {
  const bottom = number(denominator);
  if (!bottom) return 0;
  return rounded((number(numerator) / bottom) * 100, 1);
}

const MILESTONE_CTE = `
, filtered_journeys AS (
  SELECT j.*
  FROM journeys j
  WHERE ${COHORT_DATE_SQL}
    AND ${FILTER_SQL}
),
milestones AS (
  SELECT
    j.id,
    COALESCE(BOOL_OR(stage.system_key = 'contacted'), false) AS stage_contacted,
    COALESCE(BOOL_OR(stage.system_key = 'appointment_set'), false) AS stage_appointment,
    COALESCE(BOOL_OR(stage.system_key = 'visited'), false) AS stage_visited,
    COALESCE(BOOL_OR(stage.stage_type = 'won'), false) AS stage_won,
    COALESCE(BOOL_OR(stage.stage_type = 'lost'), false) AS stage_lost
  FROM filtered_journeys j
  LEFT JOIN lead_stage_history history ON history.lead_id = j.id
  LEFT JOIN pipeline_stages stage ON stage.id = history.to_stage_id
  GROUP BY j.id
),
effective_milestones AS (
  SELECT
    j.*,
    (
      m.stage_contacted OR m.stage_appointment OR m.stage_visited OR m.stage_won
      OR j.appointment_status IN ('set', 'visited')
    ) AS reached_contacted,
    (
      m.stage_appointment OR m.stage_visited OR m.stage_won
      OR j.appointment_status IN ('set', 'visited')
    ) AS reached_appointment,
    (
      m.stage_visited OR m.stage_won OR j.appointment_status = 'visited'
    ) AS reached_visited,
    m.stage_won AS reached_won,
    (m.stage_lost OR j.current_stage_type = 'lost') AS reached_lost
  FROM filtered_journeys j
  JOIN milestones m ON m.id = j.id
)
`;

async function getSummary(filters, from = filters.from, to = filters.to) {
  const result = await pool.query(
    `${JOURNEY_CTE}
     ${MILESTONE_CTE}
     SELECT
       COUNT(*)::int AS new_leads,
       COUNT(*) FILTER (WHERE reached_appointment)::int AS appointments,
       COUNT(*) FILTER (WHERE reached_visited)::int AS visits,
       COUNT(*) FILTER (WHERE reached_won)::int AS won,
       COUNT(*) FILTER (WHERE reached_lost)::int AS lost,
       COALESCE(SUM(estimated_value) FILTER (WHERE reached_won), 0)::numeric AS estimated_won_value,
       COALESCE(SUM(estimated_value) FILTER (WHERE NOT is_closed), 0)::numeric AS open_pipeline_value
     FROM effective_milestones`,
    queryParams(filters, from, to)
  );
  const row = result.rows[0] || {};
  const newLeads = number(row.new_leads);
  const won = number(row.won);
  return {
    newLeads,
    appointments: number(row.appointments),
    visits: number(row.visits),
    won,
    lost: number(row.lost),
    conversionRate: percent(won, newLeads),
    estimatedWonValue: rounded(row.estimated_won_value, 2),
    openPipelineValue: rounded(row.open_pipeline_value, 2),
  };
}

async function getFunnel(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE}
     ${MILESTONE_CTE}
     SELECT
       COUNT(*)::int AS new_leads,
       COUNT(*) FILTER (WHERE reached_contacted)::int AS contacted,
       COUNT(*) FILTER (WHERE reached_appointment)::int AS appointment,
       COUNT(*) FILTER (WHERE reached_visited)::int AS visited,
       COUNT(*) FILTER (WHERE reached_won)::int AS won
     FROM effective_milestones`,
    queryParams(filters)
  );
  const row = result.rows[0] || {};
  const stages = [
    ["New Leads", number(row.new_leads)],
    ["Contacted", number(row.contacted)],
    ["Appointment Set", number(row.appointment)],
    ["Visited Clinic", number(row.visited)],
    ["Converted / Won", number(row.won)],
  ];
  return stages.map(([label, count], index) => ({
    label,
    count,
    fromPreviousRate: index === 0 ? 100 : percent(count, stages[index - 1][1]),
    fromLeadRate: index === 0 ? 100 : percent(count, stages[0][1]),
  }));
}

async function getTrend(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE}
     ${MILESTONE_CTE},
     daily AS (
       SELECT
         TO_CHAR(journey_started_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS new_leads,
         COUNT(*) FILTER (WHERE reached_appointment)::int AS appointments,
         COUNT(*) FILTER (WHERE reached_visited)::int AS visits,
         COUNT(*) FILTER (WHERE reached_won)::int AS won
       FROM effective_milestones
       GROUP BY 1
     ),
     days AS (
       SELECT generate_series($1::date, $2::date, interval '1 day') AS day
     )
     SELECT
       TO_CHAR(days.day, 'YYYY-MM-DD') AS day,
       COALESCE(daily.new_leads, 0)::int AS new_leads,
       COALESCE(daily.appointments, 0)::int AS appointments,
       COALESCE(daily.visits, 0)::int AS visits,
       COALESCE(daily.won, 0)::int AS won
     FROM days
     LEFT JOIN daily ON daily.day = TO_CHAR(days.day, 'YYYY-MM-DD')
     ORDER BY days.day`,
    queryParams(filters)
  );
  return result.rows.map((row) => ({
    day: row.day,
    newLeads: number(row.new_leads),
    appointments: number(row.appointments),
    visits: number(row.visits),
    won: number(row.won),
  }));
}

async function getTemperature(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE}
     ${MILESTONE_CTE}
     SELECT
       temperature,
       COUNT(*)::int AS leads,
       COUNT(*) FILTER (WHERE reached_won)::int AS won
     FROM effective_milestones
     GROUP BY temperature
     ORDER BY CASE temperature WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END`,
    queryParams(filters)
  );
  const total = result.rows.reduce((sum, row) => sum + number(row.leads), 0);
  return result.rows.map((row) => ({
    temperature: row.temperature || "unknown",
    leads: number(row.leads),
    share: percent(row.leads, total),
    won: number(row.won),
    conversionRate: percent(row.won, row.leads),
  }));
}

async function getResponseTimes(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE},
     matching_journeys AS (
       SELECT j.* FROM journeys j WHERE ${FILTER_SQL}
     ),
     user_starts AS (
       SELECT j.id AS lead_id, j.contact_id, m.id AS message_id, m.created_at
       FROM matching_journeys j
       JOIN messages m ON m.contact_id = j.contact_id
       LEFT JOIN LATERAL (
         SELECT previous.role
         FROM messages previous
         WHERE previous.contact_id = j.contact_id
           AND previous.id < m.id
           AND (
             (j.started_message_id IS NOT NULL AND previous.id >= j.started_message_id)
             OR (j.started_message_id IS NULL AND previous.created_at >= j.created_at)
           )
           AND (
             (j.next_started_message_id IS NOT NULL AND previous.id < j.next_started_message_id)
             OR (
               j.next_started_message_id IS NULL
               AND (j.next_journey_created_at IS NULL OR previous.created_at < j.next_journey_created_at)
             )
           )
         ORDER BY previous.id DESC
         LIMIT 1
       ) prev ON true
       WHERE m.role = 'user'
         AND ${ACTIVITY_DATE_SQL("m.created_at")}
         AND (
           (j.started_message_id IS NOT NULL AND m.id >= j.started_message_id)
           OR (j.started_message_id IS NULL AND m.created_at >= j.created_at)
         )
         AND (
           (j.next_started_message_id IS NOT NULL AND m.id < j.next_started_message_id)
           OR (
             j.next_started_message_id IS NULL
             AND (j.next_journey_created_at IS NULL OR m.created_at < j.next_journey_created_at)
           )
         )
         AND COALESCE(prev.role, 'assistant') <> 'user'
     ),
     response_pairs AS (
       SELECT
         start.lead_id,
         start.created_at AS customer_at,
         response.created_at AS response_at,
         response.sent_by_username,
         response.is_automated_follow_up,
         EXTRACT(EPOCH FROM (response.created_at - start.created_at)) AS seconds
       FROM user_starts start
       JOIN matching_journeys j ON j.id = start.lead_id
       LEFT JOIN LATERAL (
         SELECT reply.created_at, reply.sent_by_username, reply.is_automated_follow_up
         FROM messages reply
         WHERE reply.contact_id = start.contact_id
           AND reply.id > start.message_id
           AND reply.role = 'assistant'
           AND (
             reply.delivery_status IS NULL
             OR reply.delivery_status NOT IN ('failed', 'unknown')
           )
           AND (
             (j.next_started_message_id IS NOT NULL AND reply.id < j.next_started_message_id)
             OR (
               j.next_started_message_id IS NULL
               AND (j.next_journey_created_at IS NULL OR reply.created_at < j.next_journey_created_at)
             )
           )
         ORDER BY reply.id ASC
         LIMIT 1
       ) response ON true
       WHERE response.created_at IS NOT NULL
     )
     SELECT
       CASE
         WHEN sent_by_username IS NOT NULL THEN 'staff'
         WHEN is_automated_follow_up = false THEN 'automated'
         ELSE 'other'
       END AS responder,
       COUNT(*)::int AS samples,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) AS p90_seconds
     FROM response_pairs
     WHERE seconds >= 0
     GROUP BY 1`,
    queryParams(filters)
  );

  const byType = Object.fromEntries(result.rows.map((row) => [row.responder, {
    samples: number(row.samples),
    medianSeconds: rounded(row.median_seconds, 1),
    p90Seconds: rounded(row.p90_seconds, 1),
  }]));
  return {
    automated: byType.automated || { samples: 0, medianSeconds: 0, p90Seconds: 0 },
    staff: byType.staff || { samples: 0, medianSeconds: 0, p90Seconds: 0 },
  };
}

async function getFollowUps(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE},
     matching_journeys AS (
       SELECT j.* FROM journeys j WHERE ${FILTER_SQL}
     ),
     followups AS (
       SELECT j.id AS lead_id, j.contact_id, m.id AS message_id, m.created_at
       FROM matching_journeys j
       JOIN messages m ON m.contact_id = j.contact_id
       WHERE m.role = 'assistant'
         AND m.is_automated_follow_up = true
         AND ${ACTIVITY_DATE_SQL("m.created_at")}
         AND (
           m.delivery_status IS NULL
           OR m.delivery_status NOT IN ('failed', 'unknown')
         )
         AND (
           (j.started_message_id IS NOT NULL AND m.id >= j.started_message_id)
           OR (j.started_message_id IS NULL AND m.created_at >= j.created_at)
         )
         AND (
           (j.next_started_message_id IS NOT NULL AND m.id < j.next_started_message_id)
           OR (
             j.next_started_message_id IS NULL
             AND (j.next_journey_created_at IS NULL OR m.created_at < j.next_journey_created_at)
           )
         )
     ),
     outcomes AS (
       SELECT
         f.*,
         EXISTS (
           SELECT 1 FROM messages customer_reply
           JOIN matching_journeys reply_journey ON reply_journey.id = f.lead_id
           WHERE customer_reply.contact_id = f.contact_id
             AND customer_reply.role = 'user'
             AND customer_reply.id > f.message_id
             AND customer_reply.created_at <= f.created_at + interval '72 hours'
             AND (
               reply_journey.next_started_message_id IS NULL
               OR customer_reply.id < reply_journey.next_started_message_id
             )
         ) AS replied_72h,
         EXISTS (
           SELECT 1
           FROM lead_stage_history history
           JOIN pipeline_stages stage ON stage.id = history.to_stage_id
           WHERE history.lead_id = f.lead_id
             AND stage.system_key IN ('appointment_set', 'visited')
             AND history.created_at > f.created_at
         ) AS appointment_after,
         EXISTS (
           SELECT 1
           FROM lead_stage_history history
           JOIN pipeline_stages stage ON stage.id = history.to_stage_id
           WHERE history.lead_id = f.lead_id
             AND stage.stage_type = 'won'
             AND history.created_at > f.created_at
         ) AS won_after
       FROM followups f
     )
     SELECT
       COUNT(*)::int AS sent,
       COUNT(DISTINCT lead_id)::int AS leads_followed_up,
       COUNT(*) FILTER (WHERE replied_72h)::int AS replies_72h,
       COUNT(DISTINCT lead_id) FILTER (WHERE appointment_after)::int AS leads_with_appointment_after,
       COUNT(DISTINCT lead_id) FILTER (WHERE won_after)::int AS leads_won_after
     FROM outcomes`,
    queryParams(filters)
  );
  const row = result.rows[0] || {};
  return {
    sent: number(row.sent),
    leadsFollowedUp: number(row.leads_followed_up),
    replies72h: number(row.replies_72h),
    replyRate72h: percent(row.replies_72h, row.sent),
    leadsWithAppointmentAfter: number(row.leads_with_appointment_after),
    leadsWonAfter: number(row.leads_won_after),
  };
}

const PERFORMANCE_COLUMNS = {
  branch: "branch_name",
  channel: "channel",
  source: "source",
  campaign: "campaign_name",
  treatment: "treatment_interest",
  owner: "owner_username",
};

async function getPerformance(filters, dimension, limit = 8) {
  const column = PERFORMANCE_COLUMNS[dimension];
  if (!column) throw new Error(`Unsupported analytics dimension: ${dimension}`);
  const result = await pool.query(
    `${JOURNEY_CTE}
     ${MILESTONE_CTE}
     SELECT
       COALESCE(NULLIF(TRIM(${column}), ''), 'Unspecified') AS label,
       COUNT(*)::int AS leads,
       COUNT(*) FILTER (WHERE reached_appointment)::int AS appointments,
       COUNT(*) FILTER (WHERE reached_visited)::int AS visits,
       COUNT(*) FILTER (WHERE reached_won)::int AS won,
       COALESCE(SUM(estimated_value) FILTER (WHERE reached_won), 0)::numeric AS estimated_won_value
     FROM effective_milestones
     GROUP BY 1
     ORDER BY won DESC, appointments DESC, leads DESC, label ASC
     LIMIT $9`,
    [...queryParams(filters), limit]
  );
  return result.rows.map((row) => ({
    label: row.label,
    leads: number(row.leads),
    appointments: number(row.appointments),
    visits: number(row.visits),
    won: number(row.won),
    conversionRate: percent(row.won, row.leads),
    estimatedWonValue: rounded(row.estimated_won_value, 2),
  }));
}

async function getLostReasons(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE}
     ${MILESTONE_CTE}
     SELECT
       COALESCE(NULLIF(TRIM(lost_reason), ''), 'Not specified') AS reason,
       COUNT(*)::int AS leads
     FROM effective_milestones
     WHERE reached_lost
     GROUP BY 1
     ORDER BY leads DESC, reason ASC
     LIMIT 8`,
    queryParams(filters)
  );
  const total = result.rows.reduce((sum, row) => sum + number(row.leads), 0);
  return result.rows.map((row) => ({
    reason: row.reason,
    leads: number(row.leads),
    share: percent(row.leads, total),
  }));
}

async function getAiScoring(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE},
     matching_journeys AS (
       SELECT j.* FROM journeys j WHERE ${FILTER_SQL}
     )
     SELECT
       COUNT(*)::int AS attempts,
       COUNT(*) FILTER (WHERE score.status = 'completed')::int AS completed,
       COUNT(*) FILTER (WHERE score.status = 'failed')::int AS failed,
       COUNT(*) FILTER (WHERE score.status = 'completed' AND score.confidence = 'high')::int AS high_confidence,
       COUNT(*) FILTER (WHERE score.status = 'completed' AND score.applied = true)::int AS applied
     FROM lead_temperature_scores score
     JOIN matching_journeys j ON j.id = score.lead_id
     WHERE ${ACTIVITY_DATE_SQL("score.created_at")}`,
    queryParams(filters)
  );
  const row = result.rows[0] || {};
  return {
    attempts: number(row.attempts),
    completed: number(row.completed),
    failed: number(row.failed),
    completionRate: percent(row.completed, row.attempts),
    highConfidence: number(row.high_confidence),
    applied: number(row.applied),
    appliedRate: percent(row.applied, row.completed),
  };
}

async function getDeliveryHealth(filters) {
  const result = await pool.query(
    `${JOURNEY_CTE},
     matching_journeys AS (
       SELECT j.* FROM journeys j WHERE ${FILTER_SQL}
     )
     SELECT
       COUNT(*) FILTER (WHERE m.delivery_status IS NOT NULL)::int AS tracked,
       COUNT(*) FILTER (WHERE m.delivery_status = 'failed')::int AS failed
     FROM matching_journeys j
     JOIN messages m ON m.contact_id = j.contact_id
     WHERE m.role = 'assistant'
       AND ${ACTIVITY_DATE_SQL("m.created_at")}
       AND (
         (j.started_message_id IS NOT NULL AND m.id >= j.started_message_id)
         OR (j.started_message_id IS NULL AND m.created_at >= j.created_at)
       )
       AND (
         (j.next_started_message_id IS NOT NULL AND m.id < j.next_started_message_id)
         OR (
           j.next_started_message_id IS NULL
           AND (j.next_journey_created_at IS NULL OR m.created_at < j.next_journey_created_at)
         )
       )`,
    queryParams(filters)
  );
  const row = result.rows[0] || {};
  return {
    tracked: number(row.tracked),
    failed: number(row.failed),
    failureRate: percent(row.failed, row.tracked),
  };
}

async function getFilterOptions() {
  const result = await pool.query(
    `SELECT
       ARRAY(SELECT DISTINCT branch_name FROM leads WHERE branch_name IS NOT NULL AND TRIM(branch_name) <> '' ORDER BY branch_name) AS branches,
       ARRAY(SELECT DISTINCT channel FROM contacts WHERE channel IS NOT NULL ORDER BY channel) AS channels,
       ARRAY(SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND TRIM(source) <> '' ORDER BY source) AS sources,
       ARRAY(SELECT DISTINCT campaign_name FROM leads WHERE campaign_name IS NOT NULL AND TRIM(campaign_name) <> '' ORDER BY campaign_name) AS campaigns,
       ARRAY(SELECT DISTINCT treatment_interest FROM leads WHERE treatment_interest IS NOT NULL AND TRIM(treatment_interest) <> '' ORDER BY treatment_interest) AS treatments,
       ARRAY(SELECT DISTINCT owner_username FROM leads WHERE owner_username IS NOT NULL AND TRIM(owner_username) <> '' ORDER BY owner_username) AS owners`
  );
  const row = result.rows[0] || {};
  return {
    branches: row.branches || [],
    channels: row.channels || [],
    sources: row.sources || [],
    campaigns: row.campaigns || [],
    treatments: row.treatments || [],
    owners: row.owners || [],
  };
}

function metricDelta(current, previous) {
  const currentValue = number(current);
  const previousValue = number(previous);
  if (!previousValue) return currentValue ? null : 0;
  return rounded(((currentValue - previousValue) / previousValue) * 100, 1);
}

function buildComparison(current, previous) {
  return {
    previous,
    deltas: {
      newLeads: metricDelta(current.newLeads, previous.newLeads),
      appointments: metricDelta(current.appointments, previous.appointments),
      visits: metricDelta(current.visits, previous.visits),
      won: metricDelta(current.won, previous.won),
      conversionRate: rounded(current.conversionRate - previous.conversionRate, 1),
      estimatedWonValue: metricDelta(current.estimatedWonValue, previous.estimatedWonValue),
    },
  };
}

async function getAnalytics(filters) {
  const [
    summary,
    previousSummary,
    funnel,
    trend,
    temperature,
    responseTimes,
    followUps,
    branches,
    channels,
    sources,
    campaigns,
    treatments,
    owners,
    lostReasons,
    aiScoring,
    deliveryHealth,
    filterOptions,
  ] = await Promise.all([
    getSummary(filters),
    getSummary(filters, filters.previousFrom, filters.previousTo),
    getFunnel(filters),
    getTrend(filters),
    getTemperature(filters),
    getResponseTimes(filters),
    getFollowUps(filters),
    getPerformance(filters, "branch"),
    getPerformance(filters, "channel"),
    getPerformance(filters, "source"),
    getPerformance(filters, "campaign"),
    getPerformance(filters, "treatment"),
    getPerformance(filters, "owner"),
    getLostReasons(filters),
    getAiScoring(filters),
    getDeliveryHealth(filters),
    getFilterOptions(),
  ]);

  return {
    range: {
      from: filters.from,
      to: filters.to,
      dayCount: filters.dayCount,
      timeZone: filters.timeZone,
    },
    activeFilters: {
      branch: filters.branch,
      channel: filters.channel,
      source: filters.source,
      campaign: filters.campaign,
      treatment: filters.treatment,
      owner: filters.owner,
    },
    summary,
    comparison: buildComparison(summary, previousSummary),
    funnel,
    trend,
    temperature,
    responseTimes,
    followUps,
    performance: {
      branches,
      channels,
      sources,
      campaigns,
      treatments,
      owners,
    },
    lostReasons,
    aiScoring,
    deliveryHealth,
    filterOptions,
  };
}

module.exports = {
  PERFORMANCE_COLUMNS,
  buildComparison,
  getAnalytics,
  getSummary,
  metricDelta,
  percent,
};
