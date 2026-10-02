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

function buildWebAppManifest(config = {}, env = process.env) {
  const branding = buildClientBranding(config, env);
  const manifest = {
    id: "/",
    name: branding.clientName,
    short_name: text(branding.clientName, 30) || DEFAULT_CLIENT_NAME,
    description: `${branding.clientName} staff portal`,
    start_url: "/login",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#0f172a",
  };

  // CLIENT_LOGO_URL is deployment-controlled and already restricted to HTTPS
  // or a root-relative same-origin URL. Leaving sizes/type unspecified lets the
  // browser inspect the actual file instead of us lying about dimensions for
  // arbitrary client-supplied brand assets.
  if (branding.clientLogoUrl) {
    manifest.icons = [{
      src: branding.clientLogoUrl,
      purpose: "any",
    }];
  }

  return manifest;
}

module.exports = {
  DEFAULT_CLIENT_NAME,
  DEFAULT_LOGIN_TAGLINE,
  PLACEHOLDER_BUSINESS_NAMES,
  buildClientBranding,
  buildWebAppManifest,
  configuredBusinessName,
  humanizeClientSlug,
  safeLogoUrl,
};
