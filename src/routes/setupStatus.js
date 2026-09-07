const express = require("express");
const { createSetupStatusService } = require("../services/setupStatusService");
const setupStatusRepo = require("../db/setupStatusRepo");
const aiService = require("../services/aiService");
const aiUsage = require("../services/aiUsageService");
const geminiSetupCheck = require("../services/geminiSetupCheckService");
const systemHealthService = require("../services/systemHealthService");

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

function usesGeminiMetadataSetupCheck(env = process.env) {
  const preferred = String(env.AI_PROVIDER || "gemini").trim().toLowerCase();
  return preferred === "gemini" && aiService.getGeminiApiKeys(env).length > 0;
}

async function runAllGeminiMetadataChecks() {
  const batch = await geminiSetupCheck.checkAllGeminiConnections();

  // Persist setup diagnostics separately from the runtime key-pool health.
  // A Setup Status check must never cool a key, change the active key, or
  // otherwise affect customer-reply routing.
  await Promise.allSettled(batch.results.map((item) =>
    setupStatusRepo.recordAiCandidateSetupCheck({
      candidateKey: item.healthKey,
      provider: item.provider,
      status: item.status,
      failureKind: item.failureKind,
      at: item.checkedAt,
    })
  ));

  if (batch.readyCount <= 0) {
    const error = new Error("No configured Gemini key could access the configured model metadata.");
    error.code = "ALL_GEMINI_SETUP_CHECKS_FAILED";
    throw error;
  }

  return batch;
}

const setupStatusAi = {
  ...aiService,
  async getReply(messages, options = {}) {
    if (usesGeminiMetadataSetupCheck()) {
      await runAllGeminiMetadataChecks();
      // createSetupStatusService only needs this promise to resolve. Keep a
      // compatible structured value for tests/callers without generating text.
      return JSON.stringify({
        reply: "OK",
        outcome: "normal",
        treatment: null,
        branch: null,
        appointmentPreference: null,
      });
    }
    return aiService.getReply(messages, { ...options, privateSetupCheck: true });
  },
};
const setupStatus = createSetupStatusService({ ai: setupStatusAi });

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

function failureCount(usage, kind) {
  return Number(
    (usage?.failuresByKind || []).find((item) => item.failureKind === kind)?.requests
  ) || 0;
}

async function loadCandidateSetupChecks() {
  if (!usesGeminiMetadataSetupCheck()) return [];
  try {
    return await setupStatusRepo.listAiCandidateSetupChecks();
  } catch (err) {
    console.warn("Could not load AI setup-check history:", err?.message || err);
    return [];
  }
}

async function addAiUsage(overview) {
  try {
    const [usage, setupCheckRows] = await Promise.all([
      aiUsage.getUsageSummary({ hours: 24 }),
      loadCandidateSetupChecks(),
    ]);
    const aiCheck = (overview?.checks || []).find((check) => check.key === "ai");
    const modelHealth = typeof aiService.getRuntimeGeminiModelHealth === "function"
      ? aiService.getRuntimeGeminiModelHealth()
      : [];
    if (aiCheck) {
      aiCheck.aiUsage = usage;
      aiCheck.geminiModelHealth = modelHealth;

      const setupByHealthKey = new Map(
        setupCheckRows.map((row) => [row.candidate_key, row])
      );
      const descriptors = typeof aiService.getCandidateHealthDescriptors === "function"
        ? aiService.getCandidateHealthDescriptors()
        : [];
      const healthKeyByDisplay = new Map(
        descriptors.map((item) => [`${item.provider}:${item.label}`, item.healthKey])
      );

      aiCheck.candidateHealth = (aiCheck.candidateHealth || []).map((candidate) => {
        const healthKey = healthKeyByDisplay.get(`${candidate.provider}:${candidate.label}`);
        const setupRow = healthKey ? setupByHealthKey.get(healthKey) : null;
        return {
          ...candidate,
          setupCheck: {
            status: setupRow?.last_status || "not_checked",
            failureKind: setupRow?.last_failure_kind || null,
            checkedAt: setupRow?.last_checked_at || null,
            successAt: setupRow?.last_success_at || null,
          },
        };
      });

      if (usesGeminiMetadataSetupCheck()) {
        aiCheck.setupCheckMode = "model_metadata";
        if (aiCheck.status === "ready") {
          const geminiChecks = aiCheck.candidateHealth
            .filter((candidate) => candidate.provider === "gemini")
            .map((candidate) => candidate.setupCheck)
            .filter((item) => item?.checkedAt);
          const readyChecks = geminiChecks.filter((item) => item.status === "ready").length;
          const totalKeys = Number(aiCheck.geminiKeyCount) || geminiChecks.length;
          aiCheck.summary = geminiChecks.length
            ? `${readyChecks}/${totalKeys} configured Gemini keys passed the latest metadata-only setup check. Run all checks does not generate AI text or consume prompt/output tokens.`
            : "Gemini credentials and the configured model are accessible. Run all checks uses metadata only and does not generate AI text or consume prompt/output tokens.";
        }
      }
      const usageText = usage.requests > 0
        ? `Tracked Gemini usage in the last 24h: ${formatCount(usage.requests)} request${usage.requests === 1 ? "" : "s"}, ${formatCount(usage.failedRequests)} failed, ${formatCount(usage.totalTokens)} total tokens.`
        : "No tracked Gemini usage has been recorded in the last 24h yet.";
      const modelUnavailable = failureCount(usage, "model_unavailable");
      const rateLimited = failureCount(usage, "rate_limit");
      const quotaExhausted = failureCount(usage, "quota_exhausted");
      const failureText = modelUnavailable || rateLimited || quotaExhausted
        ? ` Failures: ${formatCount(modelUnavailable)} model unavailable/503, ${formatCount(rateLimited)} rate limited, ${formatCount(quotaExhausted)} quota exhausted.`
        : "";
      const coolingModels = modelHealth.filter((item) => item.status === "cooling_down");
      const cooldownText = coolingModels.length
        ? ` Model cooldown active: ${coolingModels.map((item) => {
            const until = formatMalaysiaTime(item.cooldownUntil);
            return `${item.model}${until ? ` until ${until}` : ""}`;
          }).join(", ")}.`
        : "";
      aiCheck.summary = `${aiCheck.summary} ${usageText}${failureText}${cooldownText}`;
    }
    return { ...overview, aiUsage: usage, geminiModelHealth: modelHealth };
  } catch (err) {
    console.warn("Could not load AI usage summary:", err?.message || err);
    return overview;
  }
}

async function addSystemHealth(overview) {
  try {
    const systemHealth = await systemHealthService.getSystemHealth({
      checks: overview?.checks || [],
      aiUsage: overview?.aiUsage || null,
    });
    return { ...overview, systemHealth };
  } catch (err) {
    console.warn("Could not load operational health summary:", err?.message || err);
    return overview;
  }
}

async function decorateOverview(overview) {
  return addSystemHealth(await addAiUsage(overview));
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
module.exports.addSystemHealth = addSystemHealth;
module.exports.createGeminiDiagnosticGuard = createGeminiDiagnosticGuard;
module.exports.decorateOverview = decorateOverview;
module.exports.failureCount = failureCount;
module.exports.requireAdministrator = requireAdministrator;
module.exports.runAllGeminiMetadataChecks = runAllGeminiMetadataChecks;
module.exports.setupStatusAi = setupStatusAi;
module.exports.usesGeminiMetadataSetupCheck = usesGeminiMetadataSetupCheck;
