const crypto = require("crypto");

/** Verifies Facebook/Instagram webhook POSTs with the Meta app secret. */
function verifyMetaWebhookSignature(req, res, buf) {
  const appSecret = process.env.META_APP_SECRET;

  if (!appSecret) {
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

  const expectedSignature =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(buf).digest("hex");
  const signatureBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSignature);

  const valid =
    signatureBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

  if (!valid) {
    throw new Error("Facebook/Instagram webhook signature mismatch");
  }
}

module.exports = { verifyMetaWebhookSignature };
