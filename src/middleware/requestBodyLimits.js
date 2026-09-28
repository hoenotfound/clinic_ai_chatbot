const bodyParser = require("body-parser");

const WEBHOOK_JSON_LIMIT = "2mb";
const PORTAL_JSON_LIMIT = "100kb";

function createWebhookJsonParser(verify) {
  return bodyParser.json({
    limit: WEBHOOK_JSON_LIMIT,
    ...(typeof verify === "function" ? { verify } : {}),
  });
}

function createPortalJsonParser() {
  return bodyParser.json({ limit: PORTAL_JSON_LIMIT });
}

function isPayloadTooLargeError(err) {
  return err?.type === "entity.too.large" || err?.status === 413 || err?.statusCode === 413;
}

function payloadTooLargeErrorHandler(err, _req, res, next) {
  if (!isPayloadTooLargeError(err)) return next(err);
  return res.status(413).json({
    error: "Request body is too large.",
    code: "payload_too_large",
  });
}

module.exports = {
  PORTAL_JSON_LIMIT,
  WEBHOOK_JSON_LIMIT,
  createPortalJsonParser,
  createWebhookJsonParser,
  isPayloadTooLargeError,
  payloadTooLargeErrorHandler,
};
