const express = require("express");
const { createSetupStatusService } = require("../services/setupStatusService");

const router = express.Router();
const setupStatus = createSetupStatusService();

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Only administrators can view setup status." });
  }
  next();
}

function requestBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

router.use(requireAdministrator);

router.get("/", async (req, res) => {
  try {
    res.json(await setupStatus.getOverview({ requestBaseUrl: requestBaseUrl(req) }));
  } catch (err) {
    console.error("Failed to load setup status:", err);
    res.status(500).json({ error: "Something went wrong loading setup status." });
  }
});

router.post("/run", async (req, res) => {
  try {
    res.json(await setupStatus.runAll({ requestBaseUrl: requestBaseUrl(req) }));
  } catch (err) {
    console.error("Failed to run setup checks:", err);
    res.status(500).json({ error: "Something went wrong running setup checks." });
  }
});

module.exports = router;
module.exports.requireAdministrator = requireAdministrator;

