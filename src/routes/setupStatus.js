const express = require("express");
const configRepo = require("../db/configRepo");
const aiService = require("../services/aiService");
const geminiSetupCheck = require("../services/geminiSetupCheckService");
const {
  addAiUsage,
  addBusinessProfile,
  addSystemHealth,
  decorateOverview,
  failureCount,
  runAllGeminiMetadataChecks,
  setupStatus,
  setupStatusAi,
  usesGeminiMetadataSetupCheck,
} = require("../services/setupStatusOverviewService");

const router = express.Router();
const GEMINI_DIAGNOSTIC_COOLDOWN_MS = 10 * 60 * 1000;

function createGeminiDiagnosticGuard({
  cooldownMs = GEMINI_DIAGNOSTIC_COOLDOWN_MS,
  clock = () => Date.now(),
} = {}) {
  let inFlight = false;
  let lastStartedAtMs = 0;

  function status() {
    const nowMs = clock();
    const remainingMs = lastStartedAtMs
      ? Math.max(0, lastStartedAtMs + cooldownMs - nowMs)
      : 0;
    return {
      inFlight,
      cooldownMs,
      remainingMs,
      nextAllowedAt: remainingMs > 0
        ? new Date(nowMs + remainingMs).toISOString()
        : null,
    };
  }

  function start() {
    const current = status();
    if (current.inFlight) {
      const error = new Error("A Gemini model diagnostic is already running.");
      error.code = "GEMINI_DIAGNOSTIC_IN_PROGRESS";
      error.diagnosticStatus = current;
      throw error;
    }
    if (current.remainingMs > 0) {
      const seconds = Math.max(1, Math.ceil(current.remainingMs / 1000));
      const error = new Error(`Gemini model diagnostic can run again in ${seconds} seconds.`);
      error.code = "GEMINI_DIAGNOSTIC_COOLDOWN";
      error.diagnosticStatus = current;
      throw error;
    }

    inFlight = true;
    lastStartedAtMs = clock();
    let finished = false;
    return {
      finish() {
        if (finished) return;
        finished = true;
        inFlight = false;
      },
    };
  }

  return { start, status };
}

const geminiDiagnosticGuard = createGeminiDiagnosticGuard();


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
    const overview = await setupStatus.getOverview({ requestBaseUrl: requestBaseUrl(req) });
    res.json(await decorateOverview(overview));
  } catch (err) {
    console.error("Failed to load setup status:", err);
    res.status(500).json({ error: "Something went wrong loading setup status." });
  }
});

router.post("/run", async (req, res) => {
  try {
    const overview = await setupStatus.runAll({ requestBaseUrl: requestBaseUrl(req) });
    res.json(await decorateOverview(overview));
  } catch (err) {
    console.error("Failed to run setup checks:", err);
    res.status(500).json({ error: "Something went wrong running setup checks." });
  }
});

router.post("/business-profile", async (req, res) => {
  try {
    const businessType = req.body?.businessType;
    const businessProfile = await configRepo.selectIndustryProfile(businessType, {
      actor: req.session?.username || null,
    });
    return res.json({ businessProfile });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) {
      console.error("Failed to select business profile:", err);
    }
    return res.status(status).json({
      error: err?.message || "Something went wrong selecting the business profile.",
      code: err?.code || null,
    });
  }
});

router.get("/gemini-diagnostic/status", (req, res) => {
  res.json(geminiDiagnosticGuard.status());
});

router.post("/gemini-diagnostic", async (req, res) => {
  if (!aiService.getGeminiApiKeys(process.env).length) {
    return res.status(400).json({
      error: "No Gemini API key is configured.",
      code: "AI_PROVIDER_NOT_CONFIGURED",
    });
  }

  let lease;
  try {
    lease = geminiDiagnosticGuard.start();
  } catch (err) {
    const status = err?.code === "GEMINI_DIAGNOSTIC_COOLDOWN" ? 429 : 409;
    const diagnosticStatus = err?.diagnosticStatus || geminiDiagnosticGuard.status();
    if (diagnosticStatus.remainingMs > 0) {
      res.set("Retry-After", String(Math.max(1, Math.ceil(diagnosticStatus.remainingMs / 1000))));
    }
    return res.status(status).json({
      error: err?.message || "Gemini model diagnostic is not available yet.",
      code: err?.code || null,
      diagnosticStatus,
    });
  }

  try {
    const result = await geminiSetupCheck.runGeminiKeyModelDiagnostic();
    lease.finish();
    lease = null;
    return res.json({
      ...result,
      diagnosticStatus: geminiDiagnosticGuard.status(),
    });
  } catch (err) {
    console.error("Failed to run Gemini key/model diagnostic:", err);
    if (lease) {
      lease.finish();
      lease = null;
    }
    const status = err?.code === "AI_PROVIDER_NOT_CONFIGURED" ? 400 : 500;
    return res.status(status).json({
      error: err?.message || "Something went wrong running the Gemini diagnostic.",
      code: err?.code || null,
      diagnosticStatus: geminiDiagnosticGuard.status(),
    });
  } finally {
    if (lease) lease.finish();
  }
});

module.exports = router;
module.exports.GEMINI_DIAGNOSTIC_COOLDOWN_MS = GEMINI_DIAGNOSTIC_COOLDOWN_MS;
module.exports.addAiUsage = addAiUsage;
module.exports.addBusinessProfile = addBusinessProfile;
module.exports.addSystemHealth = addSystemHealth;
module.exports.createGeminiDiagnosticGuard = createGeminiDiagnosticGuard;
module.exports.decorateOverview = decorateOverview;
module.exports.failureCount = failureCount;
module.exports.requireAdministrator = requireAdministrator;
module.exports.runAllGeminiMetadataChecks = runAllGeminiMetadataChecks;
module.exports.setupStatusAi = setupStatusAi;
module.exports.usesGeminiMetadataSetupCheck = usesGeminiMetadataSetupCheck;
