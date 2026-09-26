const { setupStatus } = require("./setupStatusOverviewService");

function safeCheck(check) {
  if (!check) return null;
  return {
    key: check.key,
    status: check.status || "warning",
    configured: check.configured === true,
    summary: check.summary || null,
    checkedAt: check.checkedAt || null,
    lastActivityAt: check.lastActivityAt || null,
    lastWebhookAt: check.lastWebhookAt || null,
  };
}

function deriveChannelReadiness(overview, channel) {
  const checks = Array.isArray(overview?.checks) ? overview.checks : [];
  const channelCheck = safeCheck(checks.find((check) => check.key === channel));
  const webhookCheck = safeCheck(checks.find((check) => check.key === "meta_webhook"));

  if (!channelCheck?.configured) {
    return {
      state: "not_connected",
      label: "Not connected",
      detail: channel === "facebook"
        ? "Connect the Facebook Page and access token first."
        : "Connect the Instagram messaging Page and access token first.",
      channel: channelCheck,
      webhook: webhookCheck,
    };
  }

  if (
    channelCheck.status === "error" ||
    !webhookCheck?.configured ||
    ["error", "not_configured"].includes(webhookCheck?.status)
  ) {
    return {
      state: "setup_needed",
      label: "Setup needed",
      detail: channelCheck.status === "error"
        ? channelCheck.summary || "The channel connection check needs attention."
        : "The shared Facebook / Instagram webhook is not ready yet.",
      channel: channelCheck,
      webhook: webhookCheck,
    };
  }

  if (channelCheck.status === "ready" && webhookCheck.status === "ready") {
    return {
      state: "ready",
      label: "Ready",
      detail: "Messaging and signed Meta webhook activity are confirmed.",
      channel: channelCheck,
      webhook: webhookCheck,
    };
  }

  return {
    state: "setup_needed",
    label: "Setup needed",
    detail:
      channelCheck.status !== "ready"
        ? channelCheck.summary || "Send and receive a test message to confirm this channel."
        : webhookCheck?.summary || "Waiting for signed Meta webhook activity.",
    channel: channelCheck,
    webhook: webhookCheck,
  };
}

async function getCommentAutomationReadiness({
  requestBaseUrl = null,
  statusService = setupStatus,
} = {}) {
  const overview = await statusService.getOverview({ requestBaseUrl });
  return {
    checkedAt: overview?.checkedAt || null,
    facebook: deriveChannelReadiness(overview, "facebook"),
    instagram: deriveChannelReadiness(overview, "instagram"),
    note:
      "Ready confirms the existing messaging connection and signed Meta webhook activity. The first live comment test is still required to confirm comment permissions and the comment webhook subscription.",
  };
}

module.exports = {
  deriveChannelReadiness,
  getCommentAutomationReadiness,
};
