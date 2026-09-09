const express = require("express");
const configRepo = require("../db/configRepo");
const { evaluateClientSetup } = require("../services/clientSetupService");
const { evaluateGoLiveGate } = require("../services/goLiveGateService");
const setupStatusRoutes = require("./setupStatus");

const router = express.Router();

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Only administrators can view go-live readiness." });
  }
  next();
}

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

async function loadGoLiveGate({ runChecks = false, baseUrl } = {}) {
  const setupStatus = setupStatusRoutes.setupStatus;
  if (!setupStatus) {
    throw new Error("Setup Status service is unavailable.");
  }

  const rawOverview = runChecks
    ? await setupStatus.runAll({ requestBaseUrl: baseUrl })
    : await setupStatus.getOverview({ requestBaseUrl: baseUrl });
  const setupOverview = await setupStatusRoutes.decorateOverview(rawOverview);
  const config = configRepo.getConfig();
  const clientSetup = evaluateClientSetup(config);

  return evaluateGoLiveGate({
    config,
    clientSetup,
    setupOverview,
  });
}

router.use(requireAdministrator);

router.get("/", async (req, res) => {
  try {
    return res.json(await loadGoLiveGate({ baseUrl: requestBaseUrl(req) }));
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
    return res.json(await loadGoLiveGate({
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

module.exports = router;
module.exports.loadGoLiveGate = loadGoLiveGate;
module.exports.requestBaseUrl = requestBaseUrl;
module.exports.requireAdministrator = requireAdministrator;
