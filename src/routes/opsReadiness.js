const express = require("express");
const {
  requireOpsReadinessToken,
} = require("../middleware/requireOpsReadinessToken");
const { loadOpsReadiness } = require("../services/opsReadinessService");
const { getPoolActivitySnapshot } = require("../services/databasePoolActivity");

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function createOpsReadinessRouter({
  authenticate = requireOpsReadinessToken,
  loadReadiness = loadOpsReadiness,
  loadPoolActivity = getPoolActivitySnapshot,
} = {}) {
  const router = express.Router();
  router.use(authenticate);

  // Unlike full readiness, this diagnostic does not query the database.
  // Sampling it cannot by itself wake a suspended Neon compute.
  router.get("/pool-activity", (_req, res) => {
    return res.json({
      observedAt: new Date().toISOString(),
      databasePool: loadPoolActivity(),
    });
  });

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
