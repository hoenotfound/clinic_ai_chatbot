const PARTIAL_CAPTION_ERROR_PREFIX = "partial_caption_sent|";

function hasPartialCaptionMarker(errorText) {
  return String(errorText || "").startsWith(PARTIAL_CAPTION_ERROR_PREFIX);
}

function deliveryErrorForSend(sendResult, fallbackError, previousError = null) {
  if (sendResult?.success) return String(fallbackError || "");
  const base = String(fallbackError || "Message delivery failed.");
  if (sendResult?.partialCaptionSent || hasPartialCaptionMarker(previousError)) {
    return `${PARTIAL_CAPTION_ERROR_PREFIX}${base}`;
  }
  return base;
}

function publicDeliveryError(errorText) {
  const raw = String(errorText || "").trim();
  if (!hasPartialCaptionMarker(raw)) return raw;
  const detail = raw.slice(PARTIAL_CAPTION_ERROR_PREFIX.length).trim();
  return detail
    ? `The caption was sent, but the image failed to send. ${detail}`
    : "The caption was sent, but the image failed to send.";
}

module.exports = {
  PARTIAL_CAPTION_ERROR_PREFIX,
  hasPartialCaptionMarker,
  deliveryErrorForSend,
  publicDeliveryError,
};
