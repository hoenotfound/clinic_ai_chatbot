const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function toDate(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getServiceWindowEndsAt(lastInboundAt) {
  const inbound = toDate(lastInboundAt);
  if (!inbound) return null;
  return new Date(inbound.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
}

function validateScheduledTime({ scheduledFor, lastInboundAt, now = new Date() }) {
  const scheduled = toDate(scheduledFor);
  const current = toDate(now);
  const windowEndsAt = getServiceWindowEndsAt(lastInboundAt);

  if (!scheduled || !current) {
    return { valid: false, code: "invalid_time", windowEndsAt };
  }
  if (!windowEndsAt) {
    return { valid: false, code: "no_customer_message", windowEndsAt: null };
  }
  if (scheduled.getTime() <= current.getTime()) {
    return { valid: false, code: "not_future", windowEndsAt };
  }
  if (scheduled.getTime() >= windowEndsAt.getTime()) {
    return { valid: false, code: "outside_window", windowEndsAt };
  }

  return { valid: true, code: null, windowEndsAt };
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  getServiceWindowEndsAt,
  validateScheduledTime,
};
