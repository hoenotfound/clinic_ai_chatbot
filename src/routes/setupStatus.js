const express = require("express");
const { createSetupStatusService } = require("../services/setupStatusService");
const aiService = require("../services/aiService");
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

function formatMalaysiaTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function addAiUsage(overview) {
  try {
    const usage = await aiUsage.getUsageSummary({ hours: 24 });
    const aiCheck = (overview?.checks || []).find((check) => check.key === "ai");
    const modelHealth = typeof aiService.getRuntimeGeminiModelHealth === "function"
      ? aiService.getRuntimeGeminiModelHealth()
      : [];
    if (aiCheck) {
      aiCheck.aiUsage = usage;
      aiCheck.geminiModelHealth = modelHealth;
      const usageText = usage.requests > 0
        ? `Tracked Gemini usage in the last 24h: ${formatCount(usage.requests)} request${usage.requests === 1 ? "" : "s"}, ${formatCount(usage.failedRequests)} failed, ${formatCount(usage.totalTokens)} total tokens.`
        : "No tracked Gemini reply/setup usage has been recorded in the last 24h yet.";
      const coolingModels = modelHealth.filter((item) => item.status === "cooling_down");
      const cooldownText = coolingModels.length
        ? ` Model cooldown active: ${coolingModels.map((item) => {
            const until = formatMalaysiaTime(item.cooldownUntil);
            return `${item.model}${until ? ` until ${until}` : ""}`;
          }).join(", ")}.`
        : "";
      aiCheck.summary = `${aiCheck.summary} ${usageText}${cooldownText}`;
    }
    return { ...overview, aiUsage: usage, geminiModelHealth: modelHealth };
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
