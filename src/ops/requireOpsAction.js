function createRequireOpsAction() {
  return function requireOpsAction(req, res, next) {
    // A custom header cannot be submitted by a cross-site HTML form and a
    // cross-origin fetch would require CORS preflight. The Ops Registry does
    // not enable CORS, so this provides a lightweight CSRF guard for the
    // Basic-authenticated refresh endpoints without adding client sessions.
    if (String(req.get("x-ops-action") || "").trim() !== "1") {
      return res.status(403).json({ error: "Ops action confirmation required." });
    }

    const fetchSite = String(req.get("sec-fetch-site") || "").trim().toLowerCase();
    if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
      return res.status(403).json({ error: "Cross-site Ops actions are not allowed." });
    }

    return next();
  };
}

module.exports = {
  createRequireOpsAction,
};
