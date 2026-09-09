const {
  CHANNEL_CHECK_KEYS,
  evaluateReadiness,
} = require("../provisioning/readinessVerifier");
const {
  evaluateClientSetup,
  purchasedChannelContract,
} = require("./clientSetupService");

const GO_LIVE_SCHEMA_VERSION = 1;
const CHANNEL_LABELS = Object.freeze({
  whatsapp: "WhatsApp",
  facebook: "Facebook Messenger",
  instagram: "Instagram",
});

function timestampMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function uniqueIssues(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const channels = Array.isArray(item.channels) ? item.channels.join(",") : "";
    const key = `${item.key || "unknown"}|${item.status || "unknown"}|${channels}|${item.summary || ""}`;
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

function runtimeForChannel(readiness, channel) {
  return (readiness?.operationalHealth?.messaging || [])
    .find((item) => item.channel === channel) || null;
}

function channelsForIssue(item, requiredChannels = []) {
  if (Array.isArray(item?.channels) && item.channels.length) {
    return item.channels.filter((channel) => requiredChannels.includes(channel));
  }
  if (!item?.key) return [];
  return requiredChannels.filter((channel) => (
    item.key.startsWith(`${channel}_`)
    || (CHANNEL_CHECK_KEYS[channel] || []).includes(item.key)
  ));
}

function blockerBelongsToChannel(item, channel) {
  if (!item || !channel) return false;
  if (Array.isArray(item.channels) && item.channels.length) return item.channels.includes(channel);
  if (item.key?.startsWith(`${channel}_`)) return true;
  return (CHANNEL_CHECK_KEYS[channel] || []).includes(item.key);
}

function hasStableRoundTrip(runtime) {
  const inboundMs = timestampMs(runtime?.lastVerifiedRoundTripInboundAt);
  const replyMs = timestampMs(runtime?.lastVerifiedAutomatedReplyAt);
  const failureMs = timestampMs(runtime?.lastReadinessDeliveryFailureAt);
  return Boolean(
    inboundMs
    && replyMs
    && replyMs >= inboundMs
    && (!failureMs || failureMs <= replyMs)
  );
}

function classifyReadinessBlocker(item, readiness, requiredChannels) {
  if (!item?.key) return { kind: "hard", channels: [] };
  const channels = channelsForIssue(item, requiredChannels);
  const stableChannels = channels.filter((channel) => hasStableRoundTrip(runtimeForChannel(readiness, channel)));
  const unverifiedChannels = channels.filter((channel) => !stableChannels.includes(channel));

  if (/_round_trip_(?:inbound|outbound)$/.test(item.key)) {
    if (channels.length && unverifiedChannels.length === 0) return { kind: "ignore", channels };
    if (["missing", "stale", "warning"].includes(item.status)) {
      return { kind: "testing", channels: unverifiedChannels.length ? unverifiedChannels : channels };
    }
  }

  const check = channelCheck(readiness, item.key);
  if (
    check
    && check.configured === true
    && check.status === "warning"
    && check.reason === "live_evidence_pending"
  ) {
    if (channels.length && unverifiedChannels.length === 0) return { kind: "ignore", channels };
    return { kind: "testing", channels: unverifiedChannels.length ? unverifiedChannels : channels };
  }

  return { kind: "hard", channels };
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

function issueCategory(item, kind, channels) {
  if (item.key === "business_setup") return "business_setup";
  if (item.key === "business_profile") return "business_profile";
  if (item.key === "purchased_channels") return "provisioning";
  if (kind === "testing" || /_round_trip_(?:inbound|outbound)$/.test(item.key || "")) return "live_test";
  if (channels.length) return "channel_setup";
  return "system";
}

function issueAction(category, channels) {
  const labels = channels.map(channelLabel).join(" and ");
  switch (category) {
    case "business_setup":
      return "Complete the required Client Setup sections, save them, then run go-live checks again.";
    case "business_profile":
      return "Review the business-profile alignment details and correct the mismatched industry configuration.";
    case "provisioning":
      return "Set the server-owned PURCHASED_CHANNELS contract for this client, then redeploy or restart as required.";
    case "live_test":
      return `From a genuine customer account, message ${labels || "the purchased channel"}, allow the normal AI reply path to respond, then run go-live checks again.`;
    case "channel_setup":
      return `Review ${labels || "the channel"} credentials, webhook configuration and connection checks in Setup Status.`;
    default:
      return "Review the affected system check in Setup Status, fix the underlying issue, then run go-live checks again.";
  }
}

function remediationRoute(category) {
  if (category === "business_setup") return "/settings/client-setup";
  if (["business_profile", "channel_setup", "system"].includes(category)) return "/settings/setup";
  return null;
}

function decorateIssue(item, kind, requiredChannels) {
  const channels = channelsForIssue(item, requiredChannels);
  const category = issueCategory(item, kind, channels);
  return {
    ...item,
    category,
    severity: kind === "blocker" ? "error" : kind === "testing" ? "action_required" : "warning",
    channel: channels.length === 1 ? channels[0] : null,
    channels,
    action: issueAction(category, channels),
    remediationRoute: remediationRoute(category),
  };
}

function buildChannelSummary(channel, readiness, hardBlockers, testingRequired) {
  const checks = (CHANNEL_CHECK_KEYS[channel] || [])
    .map((key) => channelCheck(readiness, key))
    .filter(Boolean);
  const runtime = runtimeForChannel(readiness, channel);

  const latestInboundAt = runtime?.lastInboundAt || null;
  const verifiedInboundAt = runtime?.lastVerifiedRoundTripInboundAt || null;
  const replyAt = runtime?.lastVerifiedAutomatedReplyAt || null;
  const failureAt = runtime?.lastReadinessDeliveryFailureAt || null;
  const inboundVerified = Boolean(timestampMs(verifiedInboundAt));
  const aiReplyVerified = hasStableRoundTrip(runtime);
  const configured = checks.length > 0
    && checks.every((item) => item.configured === true)
    && runtime?.configured === true;
  const setupReady = checks.length > 0
    && checks.every((item) => (
      item.configured === true
      && (item.status === "ready" || (item.status === "warning" && item.reason === "live_evidence_pending" && aiReplyVerified))
    ));
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
    verificationState: channelHardBlockers.length
      ? "blocked"
      : channelTesting.length
        ? "needs_testing"
        : "ready",
    latestCustomerInboundAt: latestInboundAt,
    lastVerifiedRoundTripInboundAt: verifiedInboundAt,
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
  const requiredChannels = Array.isArray(contract?.channels) ? contract.channels : [];
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
        requiredChannels,
      });
      for (const item of readiness.blocking || []) {
        const classification = classifyReadinessBlocker(item, readiness, requiredChannels);
        if (classification.kind === "ignore") continue;
        const classified = classification.channels.length
          ? { ...item, channels: classification.channels }
          : item;
        if (classification.kind === "testing") testingRequired.push(classified);
        else hardBlockers.push(classified);
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

  const blockerItems = uniqueIssues(hardBlockers)
    .map((item) => decorateIssue(item, "blocker", requiredChannels));
  const testingItems = uniqueIssues(testingRequired)
    .map((item) => decorateIssue(item, "testing", requiredChannels));
  const warningItems = uniqueIssues(warnings)
    .map((item) => decorateIssue(item, "warning", requiredChannels));
  const channels = !contractBlocker && readiness
    ? requiredChannels.map((channel) => buildChannelSummary(channel, readiness, blockerItems, testingItems))
    : requiredChannels.map((channel) => ({
        channel,
        label: channelLabel(channel),
        purchased: true,
        configured: false,
        setupReady: false,
        runtimeReady: false,
        inboundVerified: false,
        aiReplyVerified: false,
        ready: false,
        verificationState: "blocked",
        latestCustomerInboundAt: null,
        lastVerifiedRoundTripInboundAt: null,
        lastVerifiedAutomatedReplyAt: null,
        lastReadinessDeliveryFailureAt: null,
        checks: [],
        blockers: [],
        testingRequired: [],
      }));

  const channelKeys = new Set(Object.values(CHANNEL_CHECK_KEYS).flat());
  const systemBlockers = readiness
    ? blockerItems.filter((item) => {
        if (["business_profile", "business_setup", "purchased_channels"].includes(item.key)) return false;
        if (channelKeys.has(item.key)) return false;
        return !requiredChannels.some((channel) => item.key?.startsWith(`${channel}_`));
      })
    : blockerItems.filter((item) => !["business_setup", "purchased_channels"].includes(item.key));

  const status = blockerItems.length > 0
    ? "blocked"
    : testingItems.length > 0
      ? "needs_testing"
      : warningItems.length > 0
        ? "ready_with_warnings"
        : "ready";
  const ready = ["ready", "ready_with_warnings"].includes(status);
  const profileReady = readiness?.businessProfile?.status === "ready";

  return {
    schemaVersion: GO_LIVE_SCHEMA_VERSION,
    status,
    ready,
    decision: {
      status,
      handoverAllowed: ready,
    },
    checkedAt: setupOverview?.checkedAt || new Date().toISOString(),
    lastTechnicalRunAt: setupOverview?.lastRunAt || null,
    businessType: config?.businessType || null,
    businessName: config?.businessName || config?.clinicName || null,
    businessSetup,
    businessProfile: readiness?.businessProfile || setupOverview?.businessProfile || null,
    profileAlignment: {
      ready: profileReady,
      expectedIndustry: readiness?.businessProfile?.expectedIndustry || config?.businessType || null,
      actualIndustry: readiness?.businessProfile?.actualIndustry || setupOverview?.businessProfile?.businessType || null,
      summary: readiness?.businessProfile?.summary || "Business-profile alignment has not been verified yet.",
    },
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
    blockers: blockerItems,
    testingRequired: testingItems,
    warnings: warningItems,
    summary: {
      blockers: blockerItems.length,
      testingRequired: testingItems.length,
      warnings: warningItems.length,
      purchasedChannels: requiredChannels.length,
      channelsReady: channels.filter((item) => item.ready).length,
    },
  };
}

module.exports = {
  CHANNEL_LABELS,
  GO_LIVE_SCHEMA_VERSION,
  blockerBelongsToChannel,
  buildChannelSummary,
  channelsForIssue,
  classifyReadinessBlocker,
  evaluateGoLiveGate,
  hasStableRoundTrip,
  uniqueIssues,
};
