const {
  DEFAULT_CLINIC_TIMEZONE,
  FALLBACK_CLINIC_TIMEZONE,
} = require("./activePromotion");

const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: true,
  start: "00:00",
  end: "07:00",
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function timeToMinutes(value) {
  const match = TIME_RE.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeQuietHours(value) {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "object" || Array.isArray(value))
  ) {
    return null;
  }

  const input = value || {};
  const enabled =
    input.enabled === undefined ? DEFAULT_QUIET_HOURS.enabled : input.enabled;
  const start =
    input.start === undefined
      ? DEFAULT_QUIET_HOURS.start
      : typeof input.start === "string"
        ? input.start.trim()
        : null;
  const end =
    input.end === undefined
      ? DEFAULT_QUIET_HOURS.end
      : typeof input.end === "string"
        ? input.end.trim()
        : null;

  if (
    typeof enabled !== "boolean" ||
    start === null ||
    end === null ||
    timeToMinutes(start) === null ||
    timeToMinutes(end) === null ||
    start === end
  ) {
    return null;
  }

  return { enabled, start, end };
}

function safeTimeZone(timeZone) {
  const requested = String(timeZone || DEFAULT_CLINIC_TIMEZONE).trim();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: requested }).format(new Date());
    return requested;
  } catch {
    return FALLBACK_CLINIC_TIMEZONE;
  }
}

function localDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localPartsEpoch(parts) {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
}

function addLocalDays(parts, days) {
  const date = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0)
  );
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function zonedLocalDateTimeToDate(target, timeZone) {
  const targetEpoch = localPartsEpoch(target);
  let guess = targetEpoch;

  // Convert a clinic-local wall-clock time back to an absolute instant without
  // assuming the server's timezone. Iterating the observed timezone offset also
  // behaves correctly for ordinary DST transitions.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localDateTimeParts(new Date(guess), timeZone);
    const delta = targetEpoch - localPartsEpoch(observed);
    if (delta === 0) break;
    guess += delta;
  }

  return new Date(guess);
}

function quietHoursStatus(
  now = new Date(),
  value = DEFAULT_QUIET_HOURS,
  { timeZone = process.env.CLINIC_TIMEZONE || DEFAULT_CLINIC_TIMEZONE } = {}
) {
  const quietHours = normalizeQuietHours(value);
  const zone = safeTimeZone(timeZone);
  if (!quietHours || !quietHours.enabled) {
    return {
      active: false,
      endsAt: null,
      timeZone: zone,
      quietHours: quietHours || { ...DEFAULT_QUIET_HOURS, enabled: false },
    };
  }

  const startMinutes = timeToMinutes(quietHours.start);
  const endMinutes = timeToMinutes(quietHours.end);
  const local = localDateTimeParts(now, zone);
  const currentMinutes = local.hour * 60 + local.minute;

  const crossesMidnight = startMinutes > endMinutes;
  const active = crossesMidnight
    ? currentMinutes >= startMinutes || currentMinutes < endMinutes
    : currentMinutes >= startMinutes && currentMinutes < endMinutes;

  if (!active) {
    return { active: false, endsAt: null, timeZone: zone, quietHours };
  }

  const endDayOffset =
    crossesMidnight && currentMinutes >= startMinutes ? 1 : 0;
  const endDate = addLocalDays(local, endDayOffset);
  const endHour = Math.floor(endMinutes / 60);
  const endMinute = endMinutes % 60;
  const endsAt = zonedLocalDateTimeToDate(
    {
      ...endDate,
      hour: endHour,
      minute: endMinute,
      second: 0,
    },
    zone
  );

  return {
    active: true,
    endsAt: endsAt.toISOString(),
    timeZone: zone,
    quietHours,
  };
}

module.exports = {
  DEFAULT_QUIET_HOURS,
  normalizeQuietHours,
  quietHoursStatus,
  timeToMinutes,
};
