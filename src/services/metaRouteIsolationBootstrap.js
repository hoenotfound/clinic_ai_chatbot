require("dotenv").config();

const metaMessaging = require("./metaMessagingService");

function text(value) {
  return String(value || "").trim();
}

function webhookChannel(body) {
  if (body?.object === "page") return "facebook";
  if (body?.object === "instagram") return "instagram";
  return null;
}

function configuredWebhookAssetId(channel, env = process.env) {
  if (channel === "facebook") return text(env.FACEBOOK_PAGE_ID) || null;
  if (channel === "instagram") return text(env.INSTAGRAM_ACCOUNT_ID) || null;
  return null;
}

function filterBodyForConfiguredAsset(body, env = process.env) {
  const channel = webhookChannel(body);
  if (!channel || !Array.isArray(body?.entry)) return body;

  const expectedAssetId = configuredWebhookAssetId(channel, env);
  // Legacy/single-client deployments did not need a routing identity. Keep
  // their historical behavior until INSTAGRAM_ACCOUNT_ID is configured or a
  // Facebook Page ID is present.
  if (!expectedAssetId) return body;

  const entries = body.entry.filter(
    (entry) => text(entry?.id) === expectedAssetId,
  );
  if (entries.length === body.entry.length) return body;
  return { ...body, entry: entries };
}

function installMetaRouteIsolation({
  service = metaMessaging,
  env = process.env,
} = {}) {
  if (!service || service.__metaRouteIsolationInstalled) return service;

  const originalParseIncomingMessages = service.parseIncomingMessages.bind(service);
  const originalResolveMessageEditEvents = service.resolveMessageEditEvents.bind(service);

  service.parseIncomingMessages = (body) =>
    originalParseIncomingMessages(filterBodyForConfiguredAsset(body, env));
  service.resolveMessageEditEvents = (body, options) =>
    originalResolveMessageEditEvents(filterBodyForConfiguredAsset(body, env), options);

  Object.defineProperty(service, "__metaRouteIsolationInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return service;
}

installMetaRouteIsolation();

module.exports = {
  configuredWebhookAssetId,
  filterBodyForConfiguredAsset,
  installMetaRouteIsolation,
  webhookChannel,
};
