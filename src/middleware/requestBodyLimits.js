const WEBHOOK_JSON_LIMIT = "2mb";
const PORTAL_JSON_LIMIT = "100kb";

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
  isPayloadTooLargeError,
  payloadTooLargeErrorHandler,
};
