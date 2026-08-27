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
    if (process.env.NODE_ENV === "production") {
      // Fail fast, same as SESSION_SECRET — an unset app secret means the
      // webhook accepts unsigned requests, so anyone who finds the URL
      // could inject fake "patient" messages that the bot processes and
      // replies to (burning WhatsApp/AI usage in the process).
      throw new Error(
        "❌ WHATSAPP_APP_SECRET is not set. Refusing to process webhook requests " +
          "in production, since without it the webhook cannot verify requests " +
          "actually came from Meta. Set WHATSAPP_APP_SECRET (see .env.example) " +
          "and restart."
      );
    }

    // Outside production (local dev/testing before the secret is
    // configured), warn loudly but don't block.
    console.warn(
      "⚠️⚠️⚠️  WHATSAPP_APP_SECRET not set — webhook signature is NOT being " +
        "verified. Anyone who finds this webhook URL can send fake messages " +
        "the bot will process and reply to. Set WHATSAPP_APP_SECRET before " +
        "exposing this server publicly or setting NODE_ENV=production.  ⚠️⚠️⚠️"
    );
    return;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }

  const expectedSignature =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(buf).digest("hex");

  const signatureBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSignature);

  // crypto.timingSafeEqual throws a RangeError (rather than returning false)
  // if the two buffers differ in length — which almost any forged or
  // malformed signature will. Check length first so a bad signature reliably
  // hits the "mismatch" branch below instead of throwing past it.
  const valid =
    signatureBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!valid) {
    throw new Error("Webhook signature mismatch — request may not be from Meta");
  }
}

module.exports = { verifyWebhookSignature };
