function parseEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function humanAgentFeatureEnabled(env = process.env) {
  return parseEnabled(env?.META_HUMAN_AGENT_ENABLED);
}

function socialMessagingChannelConfigured(channel, env = process.env) {
  if (channel === "facebook") {
    return Boolean(
      String(env?.FACEBOOK_PAGE_ID || "").trim() &&
      String(env?.FACEBOOK_PAGE_ACCESS_TOKEN || "").trim()
    );
  }
  if (channel === "instagram") {
    return Boolean(
      String(env?.INSTAGRAM_PAGE_ID || "").trim() &&
      String(env?.INSTAGRAM_PAGE_ACCESS_TOKEN || "").trim()
    );
  }
  return false;
}

function humanAgentChannelEnabled(channel, env = process.env) {
  return (
    humanAgentFeatureEnabled(env) &&
    socialMessagingChannelConfigured(channel, env)
  );
}

module.exports = {
  humanAgentChannelEnabled,
  humanAgentFeatureEnabled,
  parseEnabled,
  socialMessagingChannelConfigured,
};
