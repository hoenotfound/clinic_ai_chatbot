const express = require("express");
const {
  requireOpsReadinessToken,
} = require("../middleware/requireOpsReadinessToken");
const { loadOpsReadiness } = require("../services/opsReadinessService");

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function createOpsReadinessRouter({
  authenticate = requireOpsReadinessToken,
  loadReadiness = loadOpsReadiness,
} = {}) {
  const router = express.Router();
  router.use(authenticate);

  router.get("/", async (req, res) => {
    try {
      return res.json(await loadReadiness({ baseUrl: requestBaseUrl(req) }));
    } catch (err) {
      console.error("Failed to load operations readiness snapshot:", err);
      return res.status(503).json({
        error: "Readiness snapshot is temporarily unavailable.",
        code: "OPS_READINESS_UNAVAILABLE",
      });
    }
  });

  return router;
}

const router = createOpsReadinessRouter();

module.exports = router;
module.exports.createOpsReadinessRouter = createOpsReadinessRouter;
module.exports.requestBaseUrl = requestBaseUrl;
