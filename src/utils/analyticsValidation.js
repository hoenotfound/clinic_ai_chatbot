const ANALYTICS_TIME_ZONE = "Asia/Kuala_Lumpur";
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_CHANNELS = new Set(["whatsapp", "instagram", "facebook"]);

class AnalyticsValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AnalyticsValidationError";
    this.status = status;
  }
}

function formatDateInTimeZone(date = new Date(), timeZone = ANALYTICS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseDateOnly(value, fieldName) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new AnalyticsValidationError(`${fieldName} must use YYYY-MM-DD format.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new AnalyticsValidationError(`${fieldName} is not a valid date.`);
  }
  return date;
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(value, days) {
  const date = parseDateOnly(value, "date");
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDate(date);
}

function inclusiveDayCount(from, to) {
  const fromDate = parseDateOnly(from, "from");
  const toDate = parseDateOnly(to, "to");
  return Math.floor((toDate - fromDate) / 86400000) + 1;
}

function cleanFilter(value, fieldName, maxLength = 160) {
  if (value == null || value === "" || value === "all") return null;
  if (Array.isArray(value)) {
    throw new AnalyticsValidationError(`${fieldName} must be a single value.`);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new AnalyticsValidationError(`${fieldName} is too long.`);
  }
  return text;
}

function normalizeAnalyticsQuery(query = {}, now = new Date()) {
  const today = formatDateInTimeZone(now);
  const to = query.to ? String(query.to) : today;
  const from = query.from ? String(query.from) : shiftDate(to, -(DEFAULT_RANGE_DAYS - 1));
  const dayCount = inclusiveDayCount(from, to);

  if (dayCount < 1) {
    throw new AnalyticsValidationError("from must be on or before to.");
  }
  if (dayCount > MAX_RANGE_DAYS) {
    throw new AnalyticsValidationError(`Analytics range can't exceed ${MAX_RANGE_DAYS} days.`);
  }

  const channel = cleanFilter(query.channel, "channel", 32);
  if (channel && !ALLOWED_CHANNELS.has(channel)) {
    throw new AnalyticsValidationError("channel must be whatsapp, instagram, or facebook.");
  }

  const previousTo = shiftDate(from, -1);
  const previousFrom = shiftDate(previousTo, -(dayCount - 1));

  return {
    from,
    to,
    previousFrom,
    previousTo,
    dayCount,
    timeZone: ANALYTICS_TIME_ZONE,
    branch: cleanFilter(query.branch, "branch"),
    channel,
    source: cleanFilter(query.source, "source"),
    campaign: cleanFilter(query.campaign, "campaign"),
    treatment: cleanFilter(query.treatment, "treatment"),
    owner: cleanFilter(query.owner, "owner"),
  };
}

module.exports = {
  ALLOWED_CHANNELS,
  ANALYTICS_TIME_ZONE,
  AnalyticsValidationError,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  formatDateInTimeZone,
  inclusiveDayCount,
  normalizeAnalyticsQuery,
  shiftDate,
};
