const DEFAULT_CLIENT_NAME = "Client Portal";
const DEFAULT_LOGIN_TAGLINE = "Sign in to manage customer conversations";
const DEFAULT_APP_ICON_180_URL = "/app-icons/da-chatbot-180.png";
const DEFAULT_APP_ICON_192_URL = "/app-icons/da-chatbot-192.png";
const DEFAULT_APP_ICON_512_URL = "/app-icons/da-chatbot-512.png";
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
    clientAppIcon180Url: safeLogoUrl(env.CLIENT_APP_ICON_180_URL),
    clientAppIcon192Url: safeLogoUrl(env.CLIENT_APP_ICON_192_URL),
    clientAppIcon512Url: safeLogoUrl(env.CLIENT_APP_ICON_512_URL),
    loginTagline: text(env.CLIENT_LOGIN_TAGLINE, 160) || DEFAULT_LOGIN_TAGLINE,
  };
}

function resolveAppleTouchIconUrl(config = {}, env = process.env) {
  const branding = buildClientBranding(config, env);
  return branding.clientAppIcon180Url || DEFAULT_APP_ICON_180_URL;
}

function resolveFaviconUrl(config = {}, env = process.env) {
  const branding = buildClientBranding(config, env);
  return branding.clientAppIcon192Url || DEFAULT_APP_ICON_192_URL;
}

function buildWebAppManifest(config = {}, env = process.env) {
  const branding = buildClientBranding(config, env);
  return {
    id: "/",
    name: branding.clientName,
    short_name: text(branding.clientName, 30) || DEFAULT_CLIENT_NAME,
    description: `${branding.clientName} staff portal`,
    start_url: "/login",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0f172a",
    icons: [
      {
        src: branding.clientAppIcon192Url || DEFAULT_APP_ICON_192_URL,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: branding.clientAppIcon512Url || DEFAULT_APP_ICON_512_URL,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}

module.exports = {
  DEFAULT_CLIENT_NAME,
  DEFAULT_LOGIN_TAGLINE,
  DEFAULT_APP_ICON_180_URL,
  DEFAULT_APP_ICON_192_URL,
  DEFAULT_APP_ICON_512_URL,
  PLACEHOLDER_BUSINESS_NAMES,
  buildClientBranding,
  buildWebAppManifest,
  resolveAppleTouchIconUrl,
  resolveFaviconUrl,
  configuredBusinessName,
  humanizeClientSlug,
  safeLogoUrl,
};
