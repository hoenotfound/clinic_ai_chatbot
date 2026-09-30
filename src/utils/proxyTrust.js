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

  // This setting is used so Express can reconstruct the original HTTPS
  // protocol behind Render. Security-sensitive rate limiting does not use
  // req.ip; it uses Render's overwritten CF-Connecting-IP header instead.
  return isRenderEnvironment(env) ? 1 : false;
}

function renderClientIp(headers = {}) {
  const raw = headers?.["cf-connecting-ip"];
  if (Array.isArray(raw)) {
    if (raw.length !== 1) return null;
    return renderClientIp({ "cf-connecting-ip": raw[0] });
  }

  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.includes(",")) return null;
  return value;
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
  renderClientIp,
  resolveTrustProxy,
  rightmostForwardedAddress,
};
