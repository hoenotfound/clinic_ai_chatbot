const { loadGoLiveGate } = require("./goLiveGateLoaderService");

const ALLOWED_STATUSES = new Set([
  "ready",
  "ready_with_warnings",
  "needs_testing",
  "blocked",
]);

function deploymentCommit(env = process.env) {
  return String(
    env.RENDER_GIT_COMMIT
    || env.GIT_COMMIT_SHA
    || env.COMMIT_SHA
    || ""
  ).trim() || null;
}

function sanitizeIssues(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    key: item?.key || "unknown",
    status: item?.status || "unknown",
    category: item?.category || null,
    severity: item?.severity || null,
    channel: item?.channel || null,
    channels: Array.isArray(item?.channels) ? [...item.channels] : [],
    summary: item?.summary || "",
    action: item?.action || null,
    remediationRoute: item?.remediationRoute || null,
  }));
}

function sanitizeChannels(channels = []) {
  return (Array.isArray(channels) ? channels : []).map((item) => ({
    channel: item?.channel || null,
    label: item?.label || item?.channel || null,
    purchased: item?.purchased === true,
    configured: item?.configured === true,
    runtimeReady: item?.runtimeReady === true,
    inboundVerified: item?.inboundVerified === true,
    aiReplyVerified: item?.aiReplyVerified === true,
    ready: item?.ready === true,
    verificationState: item?.verificationState || "unknown",
    latestCustomerInboundAt: item?.latestCustomerInboundAt || null,
    lastVerifiedRoundTripInboundAt: item?.lastVerifiedRoundTripInboundAt || null,
    lastVerifiedAutomatedReplyAt: item?.lastVerifiedAutomatedReplyAt || null,
    lastReadinessDeliveryFailureAt: item?.lastReadinessDeliveryFailureAt || null,
  }));
}

function sanitizeGateForOps(gate, env = process.env) {
  const status = ALLOWED_STATUSES.has(gate?.status) ? gate.status : "blocked";
  return {
    schemaVersion: 1,
    source: "da-chatbot",
    client: {
      slug: String(env.CLIENT_SLUG || "").trim() || null,
      businessName: gate?.businessName || null,
      businessType: gate?.businessType || null,
    },
    deployment: {
      commitSha: deploymentCommit(env),
    },
    readiness: {
      status,
      ready: gate?.ready === true,
      checkedAt: gate?.checkedAt || null,
      lastTechnicalRunAt: gate?.lastTechnicalRunAt || null,
      profileAlignment: gate?.profileAlignment
        ? {
            ready: gate.profileAlignment.ready === true,
            expectedIndustry: gate.profileAlignment.expectedIndustry || null,
            actualIndustry: gate.profileAlignment.actualIndustry || null,
            summary: gate.profileAlignment.summary || "",
          }
        : null,
      businessSetup: gate?.businessSetup
        ? {
            ready: gate.businessSetup.ready === true,
            completed: Number(gate.businessSetup.completed) || 0,
            total: Number(gate.businessSetup.total) || 0,
          }
        : null,
      channelContract: gate?.channelContract
        ? {
            configured: gate.channelContract.configured === true,
            channels: Array.isArray(gate.channelContract.channels)
              ? [...gate.channelContract.channels]
              : [],
            error: gate.channelContract.error || null,
          }
        : null,
      channels: sanitizeChannels(gate?.channels),
      blockers: sanitizeIssues(gate?.blockers),
      testingRequired: sanitizeIssues(gate?.testingRequired),
      warnings: sanitizeIssues(gate?.warnings),
      summary: gate?.summary
        ? {
            blockers: Number(gate.summary.blockers) || 0,
            testingRequired: Number(gate.summary.testingRequired) || 0,
            warnings: Number(gate.summary.warnings) || 0,
            purchasedChannels: Number(gate.summary.purchasedChannels) || 0,
            channelsReady: Number(gate.summary.channelsReady) || 0,
          }
        : null,
    },
  };
}

async function loadOpsReadiness({
  env = process.env,
  loadGate = loadGoLiveGate,
  baseUrl,
} = {}) {
  const gate = await loadGate({ runChecks: false, baseUrl });
  return sanitizeGateForOps(gate, env);
}

module.exports = {
  ALLOWED_STATUSES,
  deploymentCommit,
  loadOpsReadiness,
  sanitizeGateForOps,
  sanitizeChannels,
  sanitizeIssues,
};
