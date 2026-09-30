function isRenderEnvironment(env = process.env) {
  return String(env?.RENDER || "").trim().toLowerCase() === "true";
}

function resolveTrustProxy(env = process.env) {
  const configured = String(env?.TRUST_PROXY_HOPS || "").trim();
  if (configured) {
    const hops = Number(configured);
    if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
      throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 10.");
    }
    return hops === 0 ? false : hops;
  }

  // Render places the app behind its edge proxy. Trust exactly that one hop
  // instead of trusting every address supplied through X-Forwarded-For.
  return isRenderEnvironment(env) ? 1 : false;
}

function rightmostForwardedAddress(value) {
  const raw = Array.isArray(value) ? value.join(",") : String(value || "");
  const addresses = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return addresses.length ? addresses[addresses.length - 1] : null;
}

module.exports = {
  isRenderEnvironment,
  resolveTrustProxy,
  rightmostForwardedAddress,
};
