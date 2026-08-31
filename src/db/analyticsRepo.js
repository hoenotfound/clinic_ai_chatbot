const { pool } = require("./db");

const TIME_ZONE = "Asia/Kuala_Lumpur";
const FILTER_CACHE_MS = 5 * 60 * 1000;
const ANALYTICS_QUERY_CONCURRENCY = 3;
const FOLLOW_UP_OUTCOME_WINDOW_DAYS = 14;

function createConcurrencyLimiter(limit) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError("Concurrency limit must be a positive integer.");
  }

  let active = 0;
  const queue = [];

  return async function run(work) {
    if (typeof work !== "function") {
      throw new TypeError("Concurrency-limited work must be a function.");
    }

    if (active >= limit) {
      await new Promise((resolve) => queue.push(resolve));
    }

    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

// Analytics shares the same pg Pool as live messaging. Keep a global cap across
// every Analytics request so reporting cannot consume the whole pool when
// several staff members open the dashboard at the same time.
const runAnalyticsQuery = createConcurrencyLimiter(ANALYTICS_QUERY_CONCURRENCY);

function analyticsQuery(text, params) {
  return runAnalyticsQuery(() => pool.query(text, params));
}

const JOURNEY_BASE_CTE = `
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
    l.appointment_at AS scheduled_appointment_at,
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

const MILESTONE_TIMES_CTE = `
, milestone_times AS (
  SELECT
    h.lead_id,
    MIN(h.created_at) FILTER (WHERE stage.system_key = 'contacted') AS contacted_at,
    MIN(h.created_at) FILTER (WHERE stage.system_key = 'appointment_set') AS appointment_at,
    MIN(h.created_at) FILTER (WHERE stage.system_key = 'visited') AS visited_at,
    MIN(h.created_at) FILTER (WHERE stage.stage_type = 'won') AS won_at,
    MIN(h.created_at) FILTER (WHERE stage.stage_type = 'lost') AS lost_at
  FROM lead_stage_history h
  JOIN pipeline_stages stage ON stage.id = h.to_stage_id
  GROUP BY h.lead_id
),
journeys_with_milestones AS (
  SELECT
    j.*,
    mt.contacted_at,
    mt.appointment_at AS milestone_appointment_at,
    mt.visited_at,
    mt.won_at,
    mt.lost_at,
    (
      mt.contacted_at IS NOT NULL
      OR mt.appointment_at IS NOT NULL
      OR mt.visited_at IS NOT NULL
      OR mt.won_at IS NOT NULL
      OR j.appointment_status IN ('set', 'visited')
    ) AS reached_contacted,
    (
      mt.appointment_at IS NOT NULL
      OR mt.visited_at IS NOT NULL
      OR mt.won_at IS NOT NULL
      OR j.appointment_status IN ('set', 'visited')
    ) AS reached_appointment,
    (
      mt.visited_at IS NOT NULL
      OR mt.won_at IS NOT NULL
      OR j.appointment_status = 'visited'
    ) AS reached_visited,
    (mt.won_at IS NOT NULL OR j.current_stage_type = 'won') AS reached_won,
    (mt.lost_at IS NOT NULL OR j.current_stage_type = 'lost') AS reached_lost
  FROM journeys j
  LEFT JOIN milestone_times mt ON mt.lead_id = j.id
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

function periodSql(expression, fromExpression, toExpression) {
  return `
    ${expression} >= (${fromExpression}::date::timestamp AT TIME ZONE '${TIME_ZONE}')
    AND ${expression} < (((${toExpression})::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}')
  `;
}

function queryParams(filters) {
  return [
    filters.from,
    filters.to,
    filters.branch || null,
    filters.channel || null,
    filters.source || null,
    filters.treatment || null,
    filters.owner || null,
    filters.campaign || null,
  ];
}

function allPeriodParams(filters) {
  return [...queryParams(filters), filters.previousFrom, filters.previousTo];
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
      conversionRate: rounded(number(current.conversionRate) - number(previous.conversionRate), 1),
      estimatedWonValue: metricDelta(current.estimatedWonValue, previous.estimatedWonValue),
    },
  };
}

function activityRow(row = {}) {
  return {
    newLeads: number(row.new_leads),
    appointments: number(row.appointments),
    visits: number(row.visits),
    won: number(row.won),
    estimatedWonValue: rounded(row.estimated_won_value, 2),
  };
}

async function getActivitySummary(filters) {
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE}
     ${MILESTONE_TIMES_CTE},
     matching_journeys AS (
       SELECT j.*
       FROM journeys_with_milestones j
       WHERE ${FILTER_SQL}
     ),
     periods AS (
       SELECT * FROM (VALUES
         ('current'::text, $1::date, $2::date),
         ('previous'::text, $9::date, $10::date)
       ) AS p(period, from_date, to_date)
     )
     SELECT
       p.period,
       COUNT(*) FILTER (WHERE ${periodSql("j.journey_started_at", "p.from_date", "p.to_date")})::int AS new_leads,
       COUNT(*) FILTER (WHERE j.milestone_appointment_at IS NOT NULL AND ${periodSql("j.milestone_appointment_at", "p.from_date", "p.to_date")})::int AS appointments,
       COUNT(*) FILTER (WHERE j.visited_at IS NOT NULL AND ${periodSql("j.visited_at", "p.from_date", "p.to_date")})::int AS visits,
       COUNT(*) FILTER (WHERE j.won_at IS NOT NULL AND ${periodSql("j.won_at", "p.from_date", "p.to_date")})::int AS won,
       COALESCE(SUM(j.estimated_value) FILTER (WHERE j.won_at IS NOT NULL AND ${periodSql("j.won_at", "p.from_date", "p.to_date")}), 0)::numeric AS estimated_won_value
     FROM periods p
     CROSS JOIN matching_journeys j
     GROUP BY p.period`,
    allPeriodParams(filters)
  );

  const byPeriod = Object.fromEntries(result.rows.map((row) => [row.period, activityRow(row)]));
  return {
    current: byPeriod.current || activityRow(),
    previous: byPeriod.previous || activityRow(),
  };
}

function cohortSummaryFromRow(row = {}) {
  const newLeads = number(row.new_leads);
  const contacted = number(row.contacted);
  const appointments = number(row.appointments);
  const visits = number(row.visits);
  const won = number(row.won);
  const lost = number(row.lost);
  return {
    newLeads,
    contacted,
    appointments,
    visits,
    won,
    lost,
    hotOpen: number(row.hot_open),
    estimatedWonValue: rounded(row.estimated_won_value, 2),
    openPipelineValue: rounded(row.open_pipeline_value, 2),
    appointmentRate: percent(appointments, newLeads),
    showRate: percent(visits, appointments),
    closeRate: percent(won, visits),
    conversionRate: percent(won, newLeads),
  };
}

function buildFunnel(cohort) {
  const raw = [
    ["New Leads", cohort.newLeads],
    ["Contacted", cohort.contacted],
    ["Appointment Set", cohort.appointments],
    ["Visited Clinic", cohort.visits],
    ["Converted / Won", cohort.won],
  ];
  return raw.map(([label, count], index) => {
    const previous = index === 0 ? count : raw[index - 1][1];
    return {
      label,
      count,
      fromPreviousRate: index === 0 ? 100 : percent(count, previous),
      fromLeadRate: index === 0 ? 100 : percent(count, raw[0][1]),
      dropOff: index === 0 ? 0 : Math.max(0, number(previous) - number(count)),
    };
  });
}

async function getCohortAnalytics(filters) {
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE}
     ${MILESTONE_TIMES_CTE},
     matching_journeys AS (
       SELECT j.*
       FROM journeys_with_milestones j
       WHERE ${FILTER_SQL}
     ),
     periods AS (
       SELECT * FROM (VALUES
         ('current'::text, $1::date, $2::date),
         ('previous'::text, $9::date, $10::date)
       ) AS p(period, from_date, to_date)
     ),
     cohort_rows AS (
       SELECT p.period, j.*
       FROM periods p
       JOIN matching_journeys j
         ON ${periodSql("j.journey_started_at", "p.from_date", "p.to_date")}
     ),
     cohort_summary AS (
       SELECT
         period,
         COUNT(*)::int AS new_leads,
         COUNT(*) FILTER (WHERE reached_contacted)::int AS contacted,
         COUNT(*) FILTER (WHERE reached_appointment)::int AS appointments,
         COUNT(*) FILTER (WHERE reached_visited)::int AS visits,
         COUNT(*) FILTER (WHERE reached_won)::int AS won,
         COUNT(*) FILTER (WHERE reached_lost)::int AS lost,
         COUNT(*) FILTER (WHERE temperature = 'hot' AND NOT is_closed)::int AS hot_open,
         COALESCE(SUM(estimated_value) FILTER (WHERE reached_won), 0)::numeric AS estimated_won_value,
         COALESCE(SUM(estimated_value) FILTER (WHERE NOT is_closed), 0)::numeric AS open_pipeline_value
       FROM cohort_rows
       GROUP BY period
     ),
     temperature_stats AS (
       SELECT
         period,
         COALESCE(temperature, 'unknown') AS temperature,
         COUNT(*)::int AS leads,
         COUNT(*) FILTER (WHERE reached_won)::int AS won,
         COUNT(*) FILTER (WHERE NOT is_closed)::int AS open_leads
       FROM cohort_rows
       WHERE period = 'current'
       GROUP BY period, COALESCE(temperature, 'unknown')
     ),
     lost_stats AS (
       SELECT
         COALESCE(NULLIF(TRIM(lost_reason), ''), 'Not specified') AS reason,
         COUNT(*)::int AS leads
       FROM cohort_rows
       WHERE period = 'current' AND reached_lost
       GROUP BY 1
       ORDER BY leads DESC, reason ASC
       LIMIT 8
     )
     SELECT
       cs.*,
       CASE WHEN cs.period = 'current' THEN (
         SELECT COALESCE(json_agg(json_build_object(
           'temperature', ts.temperature,
           'leads', ts.leads,
           'won', ts.won,
           'openLeads', ts.open_leads
         ) ORDER BY CASE ts.temperature WHEN 'hot' THEN 1 WHEN 'warm' THEN 2 WHEN 'cold' THEN 3 ELSE 4 END), '[]'::json)
         FROM temperature_stats ts
       ) ELSE '[]'::json END AS temperature_rows,
       CASE WHEN cs.period = 'current' THEN (
         SELECT COALESCE(json_agg(json_build_object('reason', ls.reason, 'leads', ls.leads) ORDER BY ls.leads DESC, ls.reason ASC), '[]'::json)
         FROM lost_stats ls
       ) ELSE '[]'::json END AS lost_rows
     FROM cohort_summary cs`,
    allPeriodParams(filters)
  );

  const currentRow = result.rows.find((row) => row.period === "current") || {};
  const previousRow = result.rows.find((row) => row.period === "previous") || {};
  const current = cohortSummaryFromRow(currentRow);
  const previous = cohortSummaryFromRow(previousRow);

  const rawTemperature = Array.isArray(currentRow.temperature_rows) ? currentRow.temperature_rows : [];
  const totalTemperature = rawTemperature.reduce((sum, row) => sum + number(row.leads), 0);
  const temperature = rawTemperature.map((row) => ({
    temperature: row.temperature || "unknown",
    leads: number(row.leads),
    share: percent(row.leads, totalTemperature),
    won: number(row.won),
    openLeads: number(row.openLeads),
    conversionRate: percent(row.won, row.leads),
  }));

  const rawLost = Array.isArray(currentRow.lost_rows) ? currentRow.lost_rows : [];
  const lostTotal = rawLost.reduce((sum, row) => sum + number(row.leads), 0);
  const lostReasons = rawLost.map((row) => ({
    reason: row.reason,
    leads: number(row.leads),
    share: percent(row.leads, lostTotal),
  }));

  return {
    current,
    previous,
    funnel: buildFunnel(current),
    temperature,
    lostReasons,
  };
}

async function getActivityTrend(filters) {
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE}
     ${MILESTONE_TIMES_CTE},
     matching_journeys AS (
       SELECT j.*
       FROM journeys_with_milestones j
       WHERE ${FILTER_SQL}
     ),
     events AS (
       SELECT id AS lead_id, journey_started_at AS occurred_at, 'newLeads'::text AS event_type
       FROM matching_journeys
       WHERE ${periodSql("journey_started_at", "$1", "$2")}
       UNION ALL
       SELECT id, milestone_appointment_at, 'appointments'
       FROM matching_journeys
       WHERE milestone_appointment_at IS NOT NULL AND ${periodSql("milestone_appointment_at", "$1", "$2")}
       UNION ALL
       SELECT id, visited_at, 'visits'
       FROM matching_journeys
       WHERE visited_at IS NOT NULL AND ${periodSql("visited_at", "$1", "$2")}
       UNION ALL
       SELECT id, won_at, 'won'
       FROM matching_journeys
       WHERE won_at IS NOT NULL AND ${periodSql("won_at", "$1", "$2")}
     ),
     daily AS (
       SELECT
         TO_CHAR(occurred_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM-DD') AS day,
         COUNT(*) FILTER (WHERE event_type = 'newLeads')::int AS new_leads,
         COUNT(*) FILTER (WHERE event_type = 'appointments')::int AS appointments,
         COUNT(*) FILTER (WHERE event_type = 'visits')::int AS visits,
         COUNT(*) FILTER (WHERE event_type = 'won')::int AS won
       FROM events
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

async function getResponseTimes(filters) {
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE},
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
         AND ${periodSql("m.created_at", "$1", "$2")}
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
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE},
     matching_journeys AS (
       SELECT j.* FROM journeys j WHERE ${FILTER_SQL}
     ),
     followups AS (
       SELECT j.id AS lead_id, j.contact_id, m.id AS message_id, m.created_at
       FROM matching_journeys j
       JOIN messages m ON m.contact_id = j.contact_id
       WHERE m.role = 'assistant'
         AND m.is_automated_follow_up = true
         AND ${periodSql("m.created_at", "$1", "$2")}
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
           SELECT 1
           FROM messages customer_reply
           JOIN matching_journeys reply_journey ON reply_journey.id = f.lead_id
           WHERE customer_reply.contact_id = f.contact_id
             AND customer_reply.role = 'user'
             AND customer_reply.id > f.message_id
             AND customer_reply.created_at <= f.created_at + interval '72 hours'
             AND (
               (
                 reply_journey.next_started_message_id IS NOT NULL
                 AND customer_reply.id < reply_journey.next_started_message_id
               )
               OR (
                 reply_journey.next_started_message_id IS NULL
                 AND (
                   reply_journey.next_journey_created_at IS NULL
                   OR customer_reply.created_at < reply_journey.next_journey_created_at
                 )
               )
             )
         ) AS replied_72h,
         EXISTS (
           SELECT 1
           FROM lead_stage_history history
           JOIN pipeline_stages stage ON stage.id = history.to_stage_id
           WHERE history.lead_id = f.lead_id
             AND stage.system_key = 'appointment_set'
             AND history.created_at > f.created_at
             AND history.created_at <= f.created_at + (${FOLLOW_UP_OUTCOME_WINDOW_DAYS} * interval '1 day')
         ) AS appointment_after,
         EXISTS (
           SELECT 1
           FROM lead_stage_history history
           JOIN pipeline_stages stage ON stage.id = history.to_stage_id
           WHERE history.lead_id = f.lead_id
             AND stage.stage_type = 'won'
             AND history.created_at > f.created_at
             AND history.created_at <= f.created_at + (${FOLLOW_UP_OUTCOME_WINDOW_DAYS} * interval '1 day')
         ) AS won_after
       FROM followups f
     )
     SELECT
       COUNT(*)::int AS sent,
       COUNT(DISTINCT lead_id)::int AS leads_followed_up,
       COUNT(DISTINCT lead_id) FILTER (WHERE replied_72h)::int AS leads_replied_72h,
       COUNT(DISTINCT lead_id) FILTER (WHERE appointment_after)::int AS leads_with_appointment_after,
       COUNT(DISTINCT lead_id) FILTER (WHERE won_after)::int AS leads_won_after
     FROM outcomes`,
    queryParams(filters)
  );
  const row = result.rows[0] || {};
  const leadsFollowedUp = number(row.leads_followed_up);
  const leadsReplied72h = number(row.leads_replied_72h);
  return {
    sent: number(row.sent),
    leadsFollowedUp,
    leadsReplied72h,
    replyRate72h: percent(leadsReplied72h, leadsFollowedUp),
    leadsWithAppointmentAfter: number(row.leads_with_appointment_after),
    leadsWonAfter: number(row.leads_won_after),
    outcomeWindowDays: FOLLOW_UP_OUTCOME_WINDOW_DAYS,
  };
}

const PERFORMANCE_DIMENSIONS = ["source", "campaign", "treatment", "branch", "channel", "owner"];

async function getPerformance(filters) {
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE}
     ${MILESTONE_TIMES_CTE},
     cohort AS (
       SELECT j.*
       FROM journeys_with_milestones j
       WHERE ${FILTER_SQL}
         AND ${periodSql("j.journey_started_at", "$1", "$2")}
     ),
     expanded AS (
       SELECT
         j.*,
         dimension.dimension,
         COALESCE(NULLIF(TRIM(dimension.label), ''), 'Unspecified') AS label
       FROM cohort j
       CROSS JOIN LATERAL (VALUES
         ('source'::text, j.source),
         ('campaign'::text, j.campaign_name),
         ('treatment'::text, j.treatment_interest),
         ('branch'::text, j.branch_name),
         ('channel'::text, j.channel),
         ('owner'::text, j.owner_username)
       ) AS dimension(dimension, label)
     ),
     ranked AS (
       SELECT
         dimension,
         label,
         COUNT(*)::int AS leads,
         COUNT(*) FILTER (WHERE reached_appointment)::int AS appointments,
         COUNT(*) FILTER (WHERE reached_visited)::int AS visits,
         COUNT(*) FILTER (WHERE reached_won)::int AS won,
         COALESCE(SUM(estimated_value) FILTER (WHERE reached_won), 0)::numeric AS estimated_won_value,
         ROW_NUMBER() OVER (
           PARTITION BY dimension
           ORDER BY COUNT(*) FILTER (WHERE reached_won) DESC,
                    COUNT(*) FILTER (WHERE reached_appointment) DESC,
                    COUNT(*) DESC,
                    label ASC
         ) AS rank
       FROM expanded
       GROUP BY dimension, label
     )
     SELECT dimension, label, leads, appointments, visits, won, estimated_won_value
     FROM ranked
     WHERE rank <= 8
     ORDER BY dimension, rank`,
    queryParams(filters)
  );

  const grouped = Object.fromEntries(PERFORMANCE_DIMENSIONS.map((dimension) => [dimension, []]));
  for (const row of result.rows) {
    grouped[row.dimension].push({
      label: row.label,
      leads: number(row.leads),
      appointments: number(row.appointments),
      visits: number(row.visits),
      won: number(row.won),
      conversionRate: percent(row.won, row.leads),
      estimatedWonValue: rounded(row.estimated_won_value, 2),
    });
  }
  return grouped;
}

async function getSystemHealth(filters) {
  const result = await analyticsQuery(
    `${JOURNEY_BASE_CTE},
     matching_journeys AS (
       SELECT j.* FROM journeys j WHERE ${FILTER_SQL}
     ),
     score_stats AS (
       SELECT
         COUNT(*)::int AS attempts,
         COUNT(*) FILTER (WHERE score.status = 'completed')::int AS completed,
         COUNT(*) FILTER (WHERE score.status = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE score.status = 'completed' AND score.applied = true)::int AS applied
       FROM lead_temperature_scores score
       JOIN matching_journeys j ON j.id = score.lead_id
       WHERE ${periodSql("score.created_at", "$1", "$2")}
     ),
     delivery_stats AS (
       SELECT
         COUNT(*) FILTER (WHERE m.delivery_status IS NOT NULL)::int AS tracked,
         COUNT(*) FILTER (WHERE m.delivery_status = 'failed')::int AS failed
       FROM matching_journeys j
       JOIN messages m ON m.contact_id = j.contact_id
       WHERE m.role = 'assistant'
         AND ${periodSql("m.created_at", "$1", "$2")}
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
     )
     SELECT
       score_stats.attempts AS score_attempts,
       score_stats.completed AS score_completed,
       score_stats.failed AS score_failed,
       score_stats.applied AS score_applied,
       delivery_stats.tracked AS delivery_tracked,
       delivery_stats.failed AS delivery_failed
     FROM score_stats CROSS JOIN delivery_stats`,
    queryParams(filters)
  );

  const row = result.rows[0] || {};
  const attempts = number(row.score_attempts);
  const completed = number(row.score_completed);
  const scoreFailed = number(row.score_failed);
  const deliveryTracked = number(row.delivery_tracked);
  const deliveryFailed = number(row.delivery_failed);
  return {
    aiScoring: {
      attempts,
      completed,
      failed: scoreFailed,
      completionRate: percent(completed, attempts),
      applied: number(row.score_applied),
      appliedRate: percent(row.score_applied, completed),
    },
    delivery: {
      tracked: deliveryTracked,
      failed: deliveryFailed,
      failureRate: percent(deliveryFailed, deliveryTracked),
    },
  };
}

let filterOptionsCache = { expiresAt: 0, value: null };

async function getFilterOptions() {
  if (filterOptionsCache.value && Date.now() < filterOptionsCache.expiresAt) {
    return filterOptionsCache.value;
  }
  const result = await analyticsQuery(
    `SELECT
       ARRAY(SELECT DISTINCT branch_name FROM leads WHERE branch_name IS NOT NULL AND TRIM(branch_name) <> '' ORDER BY branch_name) AS branches,
       ARRAY(SELECT DISTINCT channel FROM contacts WHERE channel IS NOT NULL ORDER BY channel) AS channels,
       ARRAY(SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND TRIM(source) <> '' ORDER BY source) AS sources,
       ARRAY(SELECT DISTINCT campaign_name FROM leads WHERE campaign_name IS NOT NULL AND TRIM(campaign_name) <> '' ORDER BY campaign_name) AS campaigns,
       ARRAY(SELECT DISTINCT treatment_interest FROM leads WHERE treatment_interest IS NOT NULL AND TRIM(treatment_interest) <> '' ORDER BY treatment_interest) AS treatments,
       ARRAY(SELECT DISTINCT owner_username FROM leads WHERE owner_username IS NOT NULL AND TRIM(owner_username) <> '' ORDER BY owner_username) AS owners`
  );
  const row = result.rows[0] || {};
  const value = {
    branches: row.branches || [],
    channels: row.channels || [],
    sources: row.sources || [],
    campaigns: row.campaigns || [],
    treatments: row.treatments || [],
    owners: row.owners || [],
  };
  filterOptionsCache = { expiresAt: Date.now() + FILTER_CACHE_MS, value };
  return value;
}

async function getAnalytics(filters) {
  const [
    activity,
    cohort,
    trend,
    responseTimes,
    followUps,
    performance,
    systemHealth,
    filterOptions,
  ] = await Promise.all([
    getActivitySummary(filters),
    getCohortAnalytics(filters),
    getActivityTrend(filters),
    getResponseTimes(filters),
    getFollowUps(filters),
    getPerformance(filters),
    getSystemHealth(filters),
    getFilterOptions(),
  ]);

  const summary = {
    ...activity.current,
    conversionRate: cohort.current.conversionRate,
  };
  const previousSummary = {
    ...activity.previous,
    conversionRate: cohort.previous.conversionRate,
  };

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
    cohort: cohort.current,
    funnel: cohort.funnel,
    trend,
    temperature: cohort.temperature,
    responseTimes,
    followUps,
    performance,
    lostReasons: cohort.lostReasons,
    systemHealth,
    filterOptions,
  };
}

module.exports = {
  ANALYTICS_QUERY_CONCURRENCY,
  PERFORMANCE_DIMENSIONS,
  buildComparison,
  buildFunnel,
  createConcurrencyLimiter,
  getAnalytics,
  metricDelta,
  percent,
};
