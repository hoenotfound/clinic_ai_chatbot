const bodyParser = require("body-parser");

const WEBHOOK_JSON_LIMIT = "2mb";
const PORTAL_JSON_LIMIT = "100kb";
const ADVANCED_CONFIG_JSON_LIMIT = "512kb";

function createWebhookJsonParser(verify) {
  return bodyParser.json({
    limit: WEBHOOK_JSON_LIMIT,
    ...(typeof verify === "function" ? { verify } : {}),
  });
}

function createPortalJsonParser(limit = PORTAL_JSON_LIMIT) {
  return bodyParser.json({ limit });
}

function createAdvancedConfigJsonParser() {
  return createPortalJsonParser(ADVANCED_CONFIG_JSON_LIMIT);
}

function isPayloadTooLargeError(err) {
  return err?.type === "entity.too.large";
}

function payloadTooLargeErrorHandler(err, _req, res, next) {
  if (!isPayloadTooLargeError(err)) return next(err);
  return res.status(413).json({
    error: "Request body is too large.",
    code: "payload_too_large",
  });
}

module.exports = {
  ADVANCED_CONFIG_JSON_LIMIT,
  PORTAL_JSON_LIMIT,
  WEBHOOK_JSON_LIMIT,
  createAdvancedConfigJsonParser,
  createPortalJsonParser,
  createWebhookJsonParser,
  isPayloadTooLargeError,
  payloadTooLargeErrorHandler,
};
