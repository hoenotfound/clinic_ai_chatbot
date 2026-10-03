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
 * Kept for backward compatibility with older callers/tests. New automated
 * promotion delivery should use getPricePromotion so a graphic is never chosen
 * solely because it happens to be first in Settings.
 */
function getActivePromotion(promotions, now = new Date(), options = {}) {
  return (
    getActivePromotions(promotions, now, options).find((promotion) => promotion.imageUrl) ||
    null
  );
}

function normalizeServiceName(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizedPromotionBound(value, fallback) {
  const text = String(value || "").trim();
  return DATE_ONLY.test(text) ? text : fallback;
}

function promotionWindowsOverlap(a, b) {
  const aStart = normalizedPromotionBound(a?.validFrom, "0000-01-01");
  const aEnd = normalizedPromotionBound(a?.validUntil, "9999-12-31");
  const bStart = normalizedPromotionBound(b?.validFrom, "0000-01-01");
  const bEnd = normalizedPromotionBound(b?.validUntil, "9999-12-31");
  return aStart <= bEnd && bStart <= aEnd;
}

function promotionPackages(promotion) {
  const configured = Array.isArray(promotion?.packages)
    ? promotion.packages.filter((item) => item && typeof item === "object")
    : [];

  if (configured.length > 0) {
    return configured.map((item) => ({
      name: String(item.name || "").trim(),
      title: String(item.title || "").trim(),
      aliases: Array.isArray(item.aliases)
        ? item.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
        : [],
      imageUrl: String(item.imageUrl || "").trim(),
      caption: String(item.caption || "").trim(),
    }));
  }

  const imageUrl = String(promotion?.imageUrl || "").trim();
  const caption = String(promotion?.caption || "").trim();
  if (!imageUrl && !caption) return [];

  // Backward compatibility: every existing single-image promotion behaves as
  // one package option without requiring a config migration.
  return [{
    name: "Main offer",
    title: String(promotion?.name || "").trim(),
    aliases: [],
    imageUrl,
    caption,
    legacy: true,
  }];
}

function packageTerms(packageOption) {
  return [
    packageOption?.name,
    packageOption?.title,
    ...(Array.isArray(packageOption?.aliases) ? packageOption.aliases : []),
  ]
    .map(normalizeServiceName)
    .filter(Boolean);
}

function findAmbiguousPromotionPackageTerm(promotion) {
  const packages = promotionPackages(promotion);
  const owners = new Map();

  packages.forEach((packageOption, index) => {
    const terms = [...new Set(packageTerms(packageOption))];
    for (const term of terms) {
      const existing = owners.get(term);
      if (existing && existing.index !== index) {
        owners.set("__ambiguity__", {
          term,
          firstPackage: existing.name,
          secondPackage: packageOption.name,
        });
        return;
      }
      owners.set(term, { index, name: packageOption.name });
    }
  });

  const ambiguity = owners.get("__ambiguity__");
  if (ambiguity) return ambiguity;
  return null;
}

function promotionTermAppearsInText(term, text) {
  const normalizedTerm = normalizeServiceName(term);
  const normalizedText = normalizeServiceName(text);
  if (!normalizedTerm || !normalizedText) return false;

  // Single-letter package aliases such as A/B/C are intentionally
  // case-sensitive. A lowercase "a" is a common English article ("have a
  // package") and must not silently select Package A. Explicit uppercase
  // "A跟B", "A price", etc. remain supported. Single-digit aliases are too
  // ambiguous for automatic routing; use a name such as "Package 1" instead.
  if (/^[a-z]$/u.test(normalizedTerm)) {
    const rawText = String(text || "");
    const explicitLetter = normalizedTerm.toUpperCase();
    return new RegExp(
      "(^|[^A-Za-z0-9])" + explicitLetter + "([^A-Za-z0-9]|$)"
    ).test(rawText);
  }
  if (/^[0-9]$/u.test(normalizedTerm)) return false;

  const paddedText = ` ${normalizedText} `;
  if (paddedText.includes(` ${normalizedTerm} `)) return true;

  // For ASCII-only multi-word terms such as "Package A", allow omitted spaces
  // while preserving an alphanumeric boundary around the whole configured
  // term. Without this, compact "packagea" would falsely match common phrases
  // such as "package available" or Malaysian "package apa ada".
  if (/^[a-z0-9 ]+$/u.test(normalizedTerm)) {
    const words = normalizedTerm.split(" ").filter(Boolean);
    const compactPattern = words.join("\\s*");
    return new RegExp(
      "(^|[^a-z0-9])" + compactPattern + "([^a-z0-9]|$)",
      "i"
    ).test(normalizedText);
  }

  // Compact matching is still useful for mixed Latin/CJK wording such as
  // "3D 小颜术" versus "3D小颜术".
  const compactTerm = normalizedTerm.replace(/\s+/g, "");
  const compactText = normalizedText.replace(/\s+/g, "");
  return compactTerm.length >= 2 && compactText.includes(compactTerm);
}

function findMentionedPromotionPackages(packages, customerText) {
  if (!customerText) return [];
  return packages.filter((packageOption) =>
    packageTerms(packageOption).some((term) =>
      promotionTermAppearsInText(term, customerText)
    )
  );
}

function resolvePromotionPackage(packages, requestedOption) {
  const requested = normalizeServiceName(requestedOption);
  if (!requested) return null;

  const compactRequested = requested.replace(/\s+/g, "");
  const matches = packages.filter((packageOption) =>
    packageTerms(packageOption).some((term) =>
      term === requested || term.replace(/\s+/g, "") === compactRequested
    )
  );
  return matches.length === 1 ? matches[0] : null;
}

function findOverlappingPricePromotionPair(promotions) {
  const enabled = (Array.isArray(promotions) ? promotions : []).filter(
    (promotion) =>
      promotion?.sendOnPriceQuery === true &&
      Boolean(normalizeServiceName(promotion?.linkedService))
  );

  for (let i = 0; i < enabled.length; i += 1) {
    for (let j = i + 1; j < enabled.length; j += 1) {
      if (
        normalizeServiceName(enabled[i].linkedService) ===
          normalizeServiceName(enabled[j].linkedService) &&
        promotionWindowsOverlap(enabled[i], enabled[j])
      ) {
        return [enabled[i], enabled[j]];
      }
    }
  }
  return null;
}

/**
 * Resolves one active service-level promotion set and then the package media
 * inside it. Generic price enquiries return every package. If the customer
 * explicitly named a package, only that exact configured package/alias returns.
 */
function getPricePromotionBundle(
  promotions,
  serviceName,
  requestedOption = null,
  now = new Date(),
  options = {}
) {
  const target = normalizeServiceName(serviceName);
  if (!target) return null;

  const serviceMatches = getActivePromotions(promotions, now, options).filter(
    (promotion) =>
      promotion?.sendOnPriceQuery === true &&
      normalizeServiceName(promotion?.linkedService) === target
  );

  // Only one active service-level campaign may own automatic price media.
  if (serviceMatches.length !== 1) return null;

  const [promotion] = serviceMatches;
  if (findAmbiguousPromotionPackageTerm(promotion)) return null;

  const packages = promotionPackages(promotion);
  if (
    packages.length === 0 ||
    packages.some((item) => !item.name || !item.imageUrl || !item.caption)
  ) {
    return null;
  }

  const requested = String(requestedOption || "").trim();
  if (!requested) {
    return { promotion, packages };
  }

  const matchedPackage = resolvePromotionPackage(packages, requested);
  return matchedPackage
    ? { promotion, packages: [matchedPackage] }
    : null;
}

/**
 * Backward-compatible helper for older callers/tests. It only returns a single
 * media option; multi-package campaigns intentionally return null.
 */
function getPricePromotion(
  promotions,
  serviceName,
  now = new Date(),
  options = {}
) {
  const bundle = getPricePromotionBundle(
    promotions,
    serviceName,
    null,
    now,
    options
  );
  if (bundle?.packages?.length !== 1) return null;
  const [packageOption] = bundle.packages;
  return {
    ...bundle.promotion,
    imageUrl: packageOption.imageUrl,
    caption: packageOption.caption,
  };
}

module.exports = {
  DEFAULT_CLINIC_TIMEZONE,
  FALLBACK_CLINIC_TIMEZONE,
  getActivePromotion,
  getActivePromotions,
  getPricePromotion,
  getPricePromotionBundle,
  promotionPackages,
  findAmbiguousPromotionPackageTerm,
  findMentionedPromotionPackages,
  findOverlappingPricePromotionPair,
  isPromotionActive,
  localDateString,
};
