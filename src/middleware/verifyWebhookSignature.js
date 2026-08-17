const crypto = require("crypto");

/**
 * Verifies that an incoming webhook POST really came from Meta, using the
 * X-Hub-Signature-256 header (HMAC-SHA256 of the raw body, signed with your
 * app's App Secret). Without this, anyone who finds your webhook URL could
 * send fake "patient messages" that the bot would process and reply to.
 *
 * Requires the raw request body — must run BEFORE body-parser's JSON parsing
 * consumes the stream, so this captures the raw bytes itself via express.json's verify hook.
 */
function verifyWebhookSignature(req, res, buf) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    // Fail loud in production-like usage, but don't block local dev/testing
    // before the secret is configured.
    console.warn(
      "⚠️  WHATSAPP_APP_SECRET not set — webhook signature is NOT being verified. " +
        "Set this before exposing the server publicly."
    );
    return;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }

  const expectedSignature =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(buf).digest("hex");

  const valid = crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expectedSignature)
  );

  if (!valid) {
    throw new Error("Webhook signature mismatch — request may not be from Meta");
  }
}

module.exports = { verifyWebhookSignature };
