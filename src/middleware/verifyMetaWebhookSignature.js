const crypto = require("crypto");

// "Instagram API with Instagram Login" signs webhook payloads with a
// separate Instagram App Secret (App Dashboard > Instagram > API setup with
// Instagram Login), distinct from the main App Secret (App Dashboard >
// Settings > Basic) used to sign Facebook Messenger payloads. Since either
// secret may be in play depending on how Instagram was connected, and a
// single app can legitimately need both, we accept a signature that matches
// ANY configured secret rather than guessing which one applies from the
// payload alone.
function candidateSecrets() {
  return [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(Boolean);
}

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

/** Verifies Facebook/Instagram webhook POSTs with the Meta app secret(s). */
function verifyMetaWebhookSignature(req, res, buf) {
  const secrets = candidateSecrets();
  // TEMPORARY DIAGNOSTIC — remove once Instagram signature verification is
  // confirmed working. Logs counts/lengths only, never the secret values.
  console.log(
    `[meta-webhook debug] candidate secrets available: ${secrets.length} ` +
      `(META_APP_SECRET len=${process.env.META_APP_SECRET?.length || 0}, ` +
      `INSTAGRAM_APP_SECRET len=${process.env.INSTAGRAM_APP_SECRET?.length || 0})`
  );

  if (secrets.length === 0) {
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

  // TEMPORARY DIAGNOSTIC — these are one-way SHA256 digests, not the secrets
  // themselves, so they're safe to share/log. This tells us whether the raw
  // body being hashed even looks right, and shows exactly what's being
  // compared against what Meta sent.
  console.log(`[meta-webhook debug] object=${(() => {
    try { return JSON.parse(buf.toString("utf8")).object; } catch { return "<unparsable>"; }
  })()}`);
  console.log(`[meta-webhook debug] content-type=${req.headers["content-type"]}`);
  console.log(`[meta-webhook debug] raw body length=${buf.length}`);
  console.log(`[meta-webhook debug] received signature header=${signatureHeader}`);
  secrets.forEach((secret, i) => {
    const computed =
      "sha256=" + crypto.createHmac("sha256", secret).update(buf).digest("hex");
    console.log(`[meta-webhook debug] secret[${i}] (len=${secret.length}) computed=${computed}`);
  });

  const valid = secrets.some((secret) => signatureMatches(secret, signatureHeader, buf));

  if (!valid) {
    throw new Error("Facebook/Instagram webhook signature mismatch");
  }
}

module.exports = { verifyMetaWebhookSignature };
