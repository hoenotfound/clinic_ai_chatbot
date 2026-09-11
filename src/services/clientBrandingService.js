const DEFAULT_CLIENT_NAME = "Client Portal";
const DEFAULT_LOGIN_TAGLINE = "Sign in to manage customer conversations";
const PLACEHOLDER_BUSINESS_NAMES = new Set([
  "your clinic",
  "your renovation business",
  "your business",
]);

function text(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function humanizeClientSlug(value) {
  return text(value, 80)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
}

function safeLogoUrl(value) {
  const raw = text(value, 2048);
  if (!raw) return "";

  if (/^\/(?!\/)/.test(raw)) return raw;

  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch (_) {
    return "";
  }
}

function configuredBusinessName(config = {}) {
  const stored = text(config.businessName || config.clinicName, 100);
  if (!stored) return "";
  return PLACEHOLDER_BUSINESS_NAMES.has(stored.toLowerCase()) ? "" : stored;
}

function buildClientBranding(config = {}, env = process.env) {
  const clientName = configuredBusinessName(config)
    || text(env.CLIENT_DISPLAY_NAME, 100)
    || humanizeClientSlug(env.CLIENT_SLUG)
    || DEFAULT_CLIENT_NAME;

  return {
    clientName,
    clientLogoUrl: safeLogoUrl(env.CLIENT_LOGO_URL),
    loginTagline: text(env.CLIENT_LOGIN_TAGLINE, 160) || DEFAULT_LOGIN_TAGLINE,
  };
}

module.exports = {
  DEFAULT_CLIENT_NAME,
  DEFAULT_LOGIN_TAGLINE,
  PLACEHOLDER_BUSINESS_NAMES,
  buildClientBranding,
  configuredBusinessName,
  humanizeClientSlug,
  safeLogoUrl,
};
