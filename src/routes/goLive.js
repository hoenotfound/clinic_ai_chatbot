const express = require("express");
const { loadGoLiveGate } = require("../services/goLiveGateLoaderService");

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Only administrators can view go-live readiness." });
  }
  next();
}

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function createGoLiveRouter({ loadGate = loadGoLiveGate } = {}) {
  const router = express.Router();
  router.use(requireAdministrator);

  router.get("/", async (req, res) => {
    try {
      return res.json(await loadGate({
        baseUrl: requestBaseUrl(req),
        runChecks: false,
      }));
    } catch (err) {
      console.error("Failed to load go-live readiness:", err);
      return res.status(500).json({
        error: "Something went wrong loading go-live readiness.",
        code: "GO_LIVE_GATE_LOAD_FAILED",
      });
    }
  });

  router.post("/run", async (req, res) => {
    try {
      return res.json(await loadGate({
        runChecks: true,
        baseUrl: requestBaseUrl(req),
      }));
    } catch (err) {
      console.error("Failed to run go-live readiness checks:", err);
      return res.status(500).json({
        error: "Something went wrong running go-live readiness checks.",
        code: "GO_LIVE_GATE_RUN_FAILED",
      });
    }
  });

  return router;
}

const router = createGoLiveRouter();

module.exports = router;
module.exports.createGoLiveRouter = createGoLiveRouter;
module.exports.loadGoLiveGate = loadGoLiveGate;
module.exports.requestBaseUrl = requestBaseUrl;
module.exports.requireAdministrator = requireAdministrator;
