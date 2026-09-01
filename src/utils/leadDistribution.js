const DEFAULT_LEAD_DISTRIBUTION = Object.freeze({
  enabled: false,
  strategy: "round_robin",
});

function normalizeLeadDistributionConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (value.strategy !== "round_robin") return null;

  return {
    enabled: value.enabled,
    strategy: "round_robin",
  };
}

module.exports = {
  DEFAULT_LEAD_DISTRIBUTION,
  normalizeLeadDistributionConfig,
};
