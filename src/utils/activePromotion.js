const FALLBACK_CLINIC_TIMEZONE = "Asia/Kuala_Lumpur";
const DEFAULT_CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || FALLBACK_CLINIC_TIMEZONE;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function formatLocalDateParts(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
}

function localDateString(date, timeZone = DEFAULT_CLINIC_TIMEZONE) {
  let parts;
  try {
    parts = formatLocalDateParts(date, timeZone);
  } catch (err) {
    // A typo in optional CLINIC_TIMEZONE must not take down AI replies or promo
    // sending. Fall back to the product's Malaysia default rather than treating
    // an expired promotion as active or throwing through the webhook path.
    console.warn(
      `Invalid CLINIC_TIMEZONE "${timeZone}"; falling back to ${FALLBACK_CLINIC_TIMEZONE}.`
    );
    parts = formatLocalDateParts(date, FALLBACK_CLINIC_TIMEZONE);
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function boundAllows(bound, now, direction, timeZone) {
  if (!bound) return true;
  const value = String(bound).trim();
  if (!value) return true;

  // Settings stores promotion dates as YYYY-MM-DD. Compare them as clinic-local
  // calendar dates so a promo ending Sep 30 stays active through the entire
  // Sep 30 clinic day instead of expiring at 08:00 Malaysia time (midnight UTC).
  if (DATE_ONLY.test(value)) {
    const today = localDateString(now, timeZone);
    return direction === "from" ? today >= value : today <= value;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false; // invalid config fails closed
  return direction === "from" ? now >= parsed : now <= parsed;
}

function isPromotionActive(
  promotion,
  now = new Date(),
  { timeZone = DEFAULT_CLINIC_TIMEZONE } = {}
) {
  if (!promotion || typeof promotion !== "object") return false;
  return (
    boundAllows(promotion.validFrom, now, "from", timeZone) &&
    boundAllows(promotion.validUntil, now, "until", timeZone)
  );
}

/**
 * Returns every currently active structured promotion. This is used by the AI
 * prompt as the single source of truth; an image is not required because some
 * clinics may configure a text-only promotion.
 */
function getActivePromotions(
  promotions,
  now = new Date(),
  options = {}
) {
  if (!Array.isArray(promotions) || promotions.length === 0) return [];
  return promotions.filter((promotion) => isPromotionActive(promotion, now, options));
}

/**
 * Picks the first active promotion that also has an image for the existing
 * first-reply promo-graphic workflow.
 */
function getActivePromotion(promotions, now = new Date(), options = {}) {
  return (
    getActivePromotions(promotions, now, options).find((promotion) => promotion.imageUrl) ||
    null
  );
}

module.exports = {
  DEFAULT_CLINIC_TIMEZONE,
  FALLBACK_CLINIC_TIMEZONE,
  getActivePromotion,
  getActivePromotions,
  isPromotionActive,
  localDateString,
};