"use strict";

// Meta error 131060 includes no message content in the Cloud API callback.
// Describe it to staff without inventing customer text or enabling AI sends.
function formatUnsupportedReview({ channelLabel, unsupportedType, detail = {} }) {
  const label = String(channelLabel || "WhatsApp");
  const type = String(unsupportedType || "unknown");
  const code = Number.isInteger(detail?.code) ? detail.code : null;

  if (label === "WhatsApp" && code === 131060) {
    return "WhatsApp message unavailable (Meta 131060). Meta did not provide the content. " +
      "For a Coexistence number, staff should check the original message in the WhatsApp Business app.";
  }

  const explanation = String(detail?.details || detail?.title || detail?.message || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const metaCode = code === null ? "Meta code unavailable" : "Meta " + code;
  return "Unsupported " + label + " message (" + type + "). " + metaCode + "." +
    (explanation ? " " + explanation : "");
}

module.exports = { formatUnsupportedReview };
