const {
  CHANNEL_CHECK_KEYS,
  evaluateReadiness,
} = require("../provisioning/readinessVerifier");
const {
  evaluateClientSetup,
  purchasedChannelContract,
} = require("./clientSetupService");

const CHANNEL_LABELS = Object.freeze({
  whatsapp: "WhatsApp",
  facebook: "Facebook Messenger",
  instagram: "Instagram",
});

const PASSIVE_CHANNEL_WARNING = /waiting for (?:the )?first valid signed webhook|send and receive a test message|waiting for real messaging activity|customer message|live messaging activity/i;

function timestampMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueIssues(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const key = `${item.key || "unknown"}|${item.status || "unknown"}|${item.summary || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || channel;
}

function channelCheck(readiness, key) {
  return (readiness?.channelChecks || []).find((item) => item.key === key) || null;
}

function isTestingBlocker(item, readiness) {
  if (!item?.key) return false;
  if (/_round_trip_(?:inbound|outbound)$/.test(item.key)) {
    return ["missing", "stale", "warning"].includes(item.status);
  }

  const check = channelCheck(readiness, item.key);
  return Boolean(
    check
    && check.configured === true
    && check.status === "warning"
    && PASSIVE_CHANNEL_WARNING.test(check.summary || item.summary || "")
  );
}

function blockerBelongsToChannel(item, channel) {
  if (!item?.key || !channel) return false;
  if (item.key.startsWith(`${channel}_`)) return true;
  return (CHANNEL_CHECK_KEYS[channel] || []).includes(item.key);
}

function buildBusinessSetup(clientSetup) {
  const incomplete = Array.isArray(clientSetup?.incompleteRequired)
    ? clientSetup.incompleteRequired
    : [];
  return {
    ready: clientSetup?.requiredComplete === true,
    completed: Number(clientSetup?.requiredCompletedCount) || 0,
    total: Number(clientSetup?.requiredTotal) || 0,
    incomplete: incomplete.map((section) => ({
      id: section.id,
      label: section.label,
      missing: Array.isArray(section.missing) ? [...section.missing] : [],
    })),
    sections: Array.isArray(clientSetup?.sections)
      ? clientSetup.sections.map((section) => ({ ...section }))
      : [],
  };
}

function buildChannelSummary(channel, readiness, hardBlockers, testingRequired) {
  const checks = (CHANNEL_CHECK_KEYS[channel] || [])
    .map((key) => channelCheck(readiness, key))
    .filter(Boolean);
  const runtime = (readiness?.operationalHealth?.messaging || [])
    .find((item) => item.channel === channel) || null;

  const inboundAt = runtime?.lastInboundAt || null;
  const replyAt = runtime?.lastVerifiedAutomatedReplyAt || null;
  const failureAt = runtime?.lastReadinessDeliveryFailureAt || null;
  const inboundMs = timestampMs(inboundAt);
  const replyMs = timestampMs(replyAt);
  const failureMs = timestampMs(failureAt);
  const inboundVerified = Boolean(inboundMs);
  const aiReplyVerified = Boolean(
    inboundMs
    && replyMs
    && replyMs >= inboundMs
    && (!failureMs || failureMs <= replyMs)
  );
  const configured = checks.length > 0
    && checks.every((item) => item.configured === true)
    && runtime?.configured === true;
  const setupReady = checks.length > 0
    && checks.every((item) => item.configured === true && item.status === "ready");
  const runtimeReady = runtime?.status === "healthy";
  const channelHardBlockers = hardBlockers.filter((item) => blockerBelongsToChannel(item, channel));
  const channelTesting = testingRequired.filter((item) => blockerBelongsToChannel(item, channel));

  return {
    channel,
    label: channelLabel(channel),
    purchased: true,
    configured,
    setupReady,
    runtimeReady,
    inboundVerified,
    aiReplyVerified,
    ready: channelHardBlockers.length === 0 && channelTesting.length === 0,
    lastInboundAt: inboundAt,
    lastVerifiedAutomatedReplyAt: replyAt,
    lastReadinessDeliveryFailureAt: failureAt,
    checks,
    blockers: channelHardBlockers,
    testingRequired: channelTesting,
  };
}

function businessSetupBlocker(businessSetup) {
  if (businessSetup.ready) return null;
  const labels = businessSetup.incomplete.map((item) => item.label).filter(Boolean);
  return {
    key: "business_setup",
    status: "incomplete",
    summary: labels.length
      ? `Complete the required Client Setup sections: ${labels.join(", ")}.`
      : "Complete all required Client Setup sections before going live.",
  };
}

function channelContractBlocker(contract) {
  if (contract?.error) {
    return {
      key: "purchased_channels",
      status: "error",
      summary: contract.error,
    };
  }
  if (contract?.configured !== true || !Array.isArray(contract.channels) || contract.channels.length === 0) {
    return {
      key: "purchased_channels",
      status: "missing",
      summary: "The purchased messaging-channel contract is not configured for this client.",
    };
  }
  return null;
}

function evaluateGoLiveGate({
  config = {},
  clientSetup = null,
  setupOverview = null,
  env = process.env,
} = {}) {
  const completion = clientSetup || evaluateClientSetup(config, env);
  const businessSetup = buildBusinessSetup(completion);
  const contract = completion?.channelContract || purchasedChannelContract(env);
  const hardBlockers = [];
  const testingRequired = [];
  const warnings = [];

  const businessBlocker = businessSetupBlocker(businessSetup);
  if (businessBlocker) hardBlockers.push(businessBlocker);

  const contractBlocker = channelContractBlocker(contract);
  if (contractBlocker) hardBlockers.push(contractBlocker);

  let readiness = null;
  if (!setupOverview) {
    hardBlockers.push({
      key: "setup_status",
      status: "missing",
      summary: "Setup Status could not be loaded, so go-live readiness cannot be verified.",
    });
  } else if (!contractBlocker) {
    try {
      readiness = evaluateReadiness(setupOverview, {
        expectedIndustry: config?.businessType,
        requiredChannels: contract.channels,
      });
      for (const item of readiness.blocking || []) {
        if (isTestingBlocker(item, readiness)) testingRequired.push(item);
        else hardBlockers.push(item);
      }
      warnings.push(...(readiness.warnings || []));
    } catch (err) {
      hardBlockers.push({
        key: err?.code || "go_live_evaluation",
        status: "error",
        summary: err?.message || "Go-live readiness could not be evaluated.",
      });
    }
  }

  const blockers = uniqueIssues(hardBlockers);
  const testing = uniqueIssues(testingRequired);
  const gateWarnings = uniqueIssues(warnings);
  const channels = !contractBlocker && readiness
    ? contract.channels.map((channel) => buildChannelSummary(channel, readiness, blockers, testing))
    : (Array.isArray(contract?.channels) ? contract.channels : []).map((channel) => ({
        channel,
        label: channelLabel(channel),
        purchased: true,
        configured: false,
        setupReady: false,
        runtimeReady: false,
        inboundVerified: false,
        aiReplyVerified: false,
        ready: false,
        lastInboundAt: null,
        lastVerifiedAutomatedReplyAt: null,
        lastReadinessDeliveryFailureAt: null,
        checks: [],
        blockers: [],
        testingRequired: [],
      }));

  const channelKeys = new Set(
    Object.values(CHANNEL_CHECK_KEYS).flat()
  );
  const requiredChannels = Array.isArray(contract?.channels) ? contract.channels : [];
  const systemBlockers = readiness
    ? blockers.filter((item) => {
        if (item.key === "business_profile" || item.key === "business_setup" || item.key === "purchased_channels") return false;
        if (channelKeys.has(item.key)) return false;
        return !requiredChannels.some((channel) => item.key?.startsWith(`${channel}_`));
      })
    : blockers.filter((item) => !["business_setup", "purchased_channels"].includes(item.key));

  const status = blockers.length > 0
    ? "blocked"
    : testing.length > 0
      ? "needs_testing"
      : gateWarnings.length > 0
        ? "ready_with_warnings"
        : "ready";
  const ready = ["ready", "ready_with_warnings"].includes(status);

  return {
    status,
    ready,
    checkedAt: setupOverview?.checkedAt || new Date().toISOString(),
    lastTechnicalRunAt: setupOverview?.lastRunAt || null,
    businessType: config?.businessType || null,
    businessName: config?.businessName || config?.clinicName || null,
    businessSetup,
    businessProfile: readiness?.businessProfile || setupOverview?.businessProfile || null,
    channelContract: {
      configured: contract?.configured === true,
      channels: requiredChannels,
      error: contract?.error || null,
      source: contract?.source || null,
    },
    system: {
      ready: systemBlockers.length === 0 && Boolean(readiness),
      applicationReady: readiness?.summary?.applicationReady || 0,
      applicationTotal: readiness?.summary?.applicationTotal || 0,
      health: readiness?.operationalHealth || setupOverview?.systemHealth || null,
      blockers: systemBlockers,
    },
    channels,
    blockers,
    testingRequired: testing,
    warnings: gateWarnings,
    summary: {
      blockers: blockers.length,
      testingRequired: testing.length,
      warnings: gateWarnings.length,
      purchasedChannels: requiredChannels.length,
      channelsReady: channels.filter((item) => item.ready).length,
    },
  };
}

module.exports = {
  CHANNEL_LABELS,
  PASSIVE_CHANNEL_WARNING,
  blockerBelongsToChannel,
  buildChannelSummary,
  evaluateGoLiveGate,
  isTestingBlocker,
  uniqueIssues,
};
