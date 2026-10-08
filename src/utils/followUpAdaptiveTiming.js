// Shared by discovery, wake-up, AI leasing, decisions and atomic claims.
const { normalizeQuietHours, DEFAULT_QUIET_HOURS, timeToMinutes } = require("./quietHours");
const { DEFAULT_CLINIC_TIMEZONE, FALLBACK_CLINIC_TIMEZONE } = require("./activePromotion");
const FINAL_STEP = 3;
const FINAL_MIN_SPACING_MINUTES = 120;
const QUIET_START_SAFETY_MINUTES = 30;

function safeTimeZone(value) {
  const zone = String(value || DEFAULT_CLINIC_TIMEZONE);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone.replace(/'/g, "''");
  } catch {
    return FALLBACK_CLINIC_TIMEZONE.replace(/'/g, "''");
  }
}

// Build a PostgreSQL expression for the scheduled time of pre-expiry follow-ups.
// Earlier sequence steps retain the configured spacing. Step 3 uses an actual
// 2h separation from Step 2, and moves out of quiet hours when possible.
function beforeExpiryDueSql({
  inbound, previous, step, offset, gap,
  quietHours = DEFAULT_QUIET_HOURS,
  timeZone = process.env.CLINIC_TIMEZONE || DEFAULT_CLINIC_TIMEZONE,
  reservePricingMinutes = 0,
  channel = "'whatsapp'",
}) {
  const quiet = normalizeQuietHours(quietHours) || DEFAULT_QUIET_HOURS;
  const nominal = `(${inbound} + ((1440 - ${offset}) * interval '1 minute'))`;
  const previousDue = `(CASE WHEN ${step} = ${FINAL_STEP}
    THEN ${previous} + interval '${FINAL_MIN_SPACING_MINUTES} minutes'
    ELSE ${previous} + (${gap} * interval '1 minute')
  END)`;
  let target = nominal;
  if (quiet.enabled) {
    const zone = safeTimeZone(timeZone);
    const start = timeToMinutes(quiet.start);
    const end = timeToMinutes(quiet.end);
    const local = `(${nominal} AT TIME ZONE '${zone}')`;
    const wallTime = `(${local}::time)`;
    const overnight = start > end;
    const inQuiet = overnight
      ? `(${wallTime} >= '${quiet.start}'::time OR ${wallTime} < '${quiet.end}'::time)`
      : `(${wallTime} >= '${quiet.start}'::time AND ${wallTime} < '${quiet.end}'::time)`;
    const previousDay = overnight
      ? `(CASE WHEN ${wallTime} < '${quiet.end}'::time THEN interval '1 day' ELSE interval '0 days' END)`
      : `interval '0 days'`;
    const nextDay = overnight
      ? `(CASE WHEN ${wallTime} >= '${quiet.start}'::time THEN interval '1 day' ELSE interval '0 days' END)`
      : `interval '0 days'`;
    const startLocal = `(date_trunc('day', ${local}) - ${previousDay} + interval '${start} minutes')`;
    const endLocal = `(date_trunc('day', ${local}) + ${nextDay} + interval '${end} minutes')`;
    const lastSafe = `((${startLocal} AT TIME ZONE '${zone}') - interval '${QUIET_START_SAFETY_MINUTES} minutes')`;
    const quietEnds = `(${endLocal} AT TIME ZONE '${zone}')`;
    const afterPrevious = `(${previous} + interval '${FINAL_MIN_SPACING_MINUTES} minutes')`;
    // A testimonial at 23:58 is legal by itself, but its price graphic at
    // 00:03 is not. Treat the final 5 minutes before quiet hours as a
    // pre-quiet scheduling conflict only for WhatsApp pricing sequences.
    const extra = Number(reservePricingMinutes) === 5 ? 5 : 0;
    const imminent = extra
      ? `(${channel} = 'whatsapp' AND
         (CASE WHEN '${quiet.start}'::time <
           ('${quiet.start}'::time - interval '${extra} minutes')
          THEN (${wallTime} >= ('${quiet.start}'::time - interval '${extra} minutes')
            OR ${wallTime} < '${quiet.start}'::time)
          ELSE (${wallTime} >= ('${quiet.start}'::time - interval '${extra} minutes')
            AND ${wallTime} < '${quiet.start}'::time)
         END))`
      : 'FALSE';
    const imminentShift = `(CASE WHEN ${wallTime} >= '${quiet.start}'::time
      THEN interval '1 day' ELSE interval '0 days' END)`;
    const imminentStart = `(date_trunc('day', ${local}) + ${imminentShift}
      + interval '${start} minutes')`;
    const imminentLastSafe = `((${imminentStart} AT TIME ZONE '${zone}')
      - interval '${QUIET_START_SAFETY_MINUTES} minutes')`;
    const imminentEnd = `((date_trunc('day', ${local}) + ${imminentShift}
      + interval '${overnight ? 1440 : 0} minutes' + interval '${end} minutes')
      AT TIME ZONE '${zone}')`;
    const useLastSafe = `(CASE WHEN ${imminent} THEN ${imminentLastSafe}
      ELSE ${lastSafe} END)`;
    const useQuietEnd = `(CASE WHEN ${imminent} THEN ${imminentEnd}
      ELSE ${quietEnds} END)`;
    // Never break the 2-hour gap to Step 2 to fit an earlier quiet slot.
    target = `(CASE WHEN ${step} = ${FINAL_STEP} AND (${inQuiet} OR ${imminent})
      THEN CASE WHEN ${previous} IS NOT NULL AND ${afterPrevious} > ${useLastSafe}
        THEN GREATEST(${afterPrevious}, ${useQuietEnd})
        ELSE ${useLastSafe}
      END
      ELSE ${nominal}
    END)`;
  }
  return `GREATEST(${target}, COALESCE(${previousDue}, ${target}))`;
}
module.exports = { beforeExpiryDueSql, FINAL_MIN_SPACING_MINUTES, QUIET_START_SAFETY_MINUTES };
