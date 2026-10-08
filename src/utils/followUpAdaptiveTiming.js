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
    // If the 2h gap would cross the last safe pre-quiet slot, wait until
    // quiet hours end instead. The caller's 23h50 deadline may then reject it.
    target = `(CASE WHEN ${step} = ${FINAL_STEP} AND ${inQuiet}
      THEN CASE WHEN ${previous} IS NOT NULL AND ${afterPrevious} > ${lastSafe}
        THEN GREATEST(${afterPrevious}, ${quietEnds})
        ELSE ${lastSafe}
      END
      ELSE ${nominal}
    END)`;
  }
  // If the 20-hour nominal slot falls in quiet hours, move the final
  // follow-up to the last safe slot before quiet hours when there is still
  // at least a two-hour gap after Step 2. This can intentionally be earlier
  // than hour 20 so its five-minute pricing reminder also fits before quiet
  // hours. If Step 2 is too late, defer until quiet hours finish; the normal
  // WhatsApp window checks will reject delivery after the window expires.
  return `GREATEST(${target}, COALESCE(${previousDue}, ${target}))`;
}
module.exports = { beforeExpiryDueSql, FINAL_MIN_SPACING_MINUTES, QUIET_START_SAFETY_MINUTES };
