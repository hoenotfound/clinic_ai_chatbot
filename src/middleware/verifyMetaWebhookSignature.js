const crypto = require("crypto");

function signatureMatches(secret, signatureHeader, buf) {
  const expectedSignature =
    "sha256=" + crypto.createHmac("sha256", secret).update(buf).digest("hex");
  const signatureBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSignature);
  return (
    signatureBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  );
}

/**
 * Verifies Facebook Messenger and Instagram Messaging webhook POSTs using the
 * Meta app secret from App Settings > Basic. Both channels are configured
 * through the same Messenger from Meta app and share /meta-webhook.
 */
function verifyMetaWebhookSignature(req, res, buf) {
  const secret = process.env.META_APP_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "META_APP_SECRET is not set. Refusing to process Facebook/Instagram webhook requests in production."
      );
    }
    console.warn(
      "META_APP_SECRET not set. Facebook/Instagram webhook signatures are not being verified in development."
    );
    return;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader) {
    throw new Error("Missing X-Hub-Signature-256 header");
  }

  if (!signatureMatches(secret, signatureHeader, buf)) {
    throw new Error("Facebook/Instagram webhook signature mismatch");
  }
}

module.exports = { verifyMetaWebhookSignature };
