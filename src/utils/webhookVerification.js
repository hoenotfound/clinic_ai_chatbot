const crypto = require("crypto");

function tokenDigest(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function verifyTokenMatches(providedToken, configuredToken) {
  if (typeof providedToken !== "string" || typeof configuredToken !== "string") {
    return false;
  }

  if (!providedToken || !configuredToken) {
    return false;
  }

  // Hash first so timingSafeEqual always receives equal-length buffers and
  // verification does not fall back to a normal string equality comparison.
  return crypto.timingSafeEqual(
    tokenDigest(providedToken),
    tokenDigest(configuredToken)
  );
}

module.exports = {
  verifyTokenMatches,
};
