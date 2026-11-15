"use strict";

// Only fixed, non-sensitive categories are returned. Do not use raw paths,
// IDs, usernames, webhook bodies, query strings or request headers as labels.
// This passive classification causes no SQL/network calls and does not inspect
// request content or mutate the response.
function httpDatabaseActivitySource(req = {}) {
  const path = typeof req.path === "string" ? req.path : "";
  if (path === "/webhook" || path === "/whatsapp/default" ||
      path === "/whatsapp/secondary-qa-capture" ||
      path === "/pr395-preidentity-webhook" ||
      path === "/pr395-legacy-lifecycle-webhook") {
    return "HTTP WhatsApp ingress";
  }
  if (path === "/meta-webhook") return "HTTP Meta webhook";
  if (path === "/api/conversations") return "HTTP Inbox list";
  if (path.startsWith("/api/conversations/")) return "HTTP Inbox detail";
  if (path === "/api/pipeline" || path.startsWith("/api/pipeline/") ||
      path === "/api/sales-follow-up" || path.startsWith("/api/sales-follow-up/")) {
    return "HTTP pipeline API";
  }
  if (path === "/api/config" || path.startsWith("/api/config/") ||
      path === "/api/advanced-config" || path.startsWith("/api/advanced-config/")) {
    return "HTTP configuration API";
  }
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return "HTTP auth API";
  if (path === "/api" || path.startsWith("/api/")) return "HTTP other API";
  if (path.startsWith("/promo-images/")) return "HTTP promo media";
  if (path === "/" || path === "/health" || path.startsWith("/health/")) return "HTTP health";
  return "HTTP other";
}
module.exports = { httpDatabaseActivitySource };
