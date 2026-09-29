function parseEnabled(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "").trim().toLowerCase()
  );
}

function humanAgentFeatureEnabled(env = process.env) {
  return parseEnabled(env?.META_HUMAN_AGENT_ENABLED);
}

module.exports = {
  humanAgentFeatureEnabled,
  parseEnabled,
};
