const express = require("express");
const { createSetupStatusService } = require("../services/setupStatusService");
const aiUsage = require("../services/aiUsageService");

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

function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

async function addAiUsage(overview) {
  try {
    const usage = await aiUsage.getUsageSummary({ hours: 24 });
    const aiCheck = (overview?.checks || []).find((check) => check.key === "ai");
    if (aiCheck) {
      aiCheck.aiUsage = usage;
      const usageText = usage.requests > 0
        ? `Tracked Gemini usage in the last 24h: ${formatCount(usage.requests)} request${usage.requests === 1 ? "" : "s"}, ${formatCount(usage.failedRequests)} failed, ${formatCount(usage.totalTokens)} total tokens.`
        : "No tracked Gemini reply/setup usage has been recorded in the last 24h yet.";
      aiCheck.summary = `${aiCheck.summary} ${usageText}`;
    }
    return { ...overview, aiUsage: usage };
  } catch (err) {
    console.warn("Could not load AI usage summary:", err?.message || err);
    return overview;
  }
}

router.use(requireAdministrator);

router.get("/", async (req, res) => {
  try {
    const overview = await setupStatus.getOverview({ requestBaseUrl: requestBaseUrl(req) });
    res.json(await addAiUsage(overview));
  } catch (err) {
    console.error("Failed to load setup status:", err);
    res.status(500).json({ error: "Something went wrong loading setup status." });
  }
});

router.post("/run", async (req, res) => {
  try {
    const overview = await setupStatus.runAll({ requestBaseUrl: requestBaseUrl(req) });
    res.json(await addAiUsage(overview));
  } catch (err) {
    console.error("Failed to run setup checks:", err);
    res.status(500).json({ error: "Something went wrong running setup checks." });
  }
});

module.exports = router;
module.exports.addAiUsage = addAiUsage;
module.exports.requireAdministrator = requireAdministrator;
