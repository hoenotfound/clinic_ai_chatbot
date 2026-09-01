const DEFAULT_LEAD_DISTRIBUTION = Object.freeze({
  enabled: false,
  strategy: "round_robin",
  assignByBranch: true,
});

function normalizeLeadDistributionConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (value.strategy !== "round_robin") return null;

  // Keep branch-aware routing enabled for existing saved configs and older
  // clients that predate this toggle. Staff can explicitly turn it off from
  // Tools when one centralized Sales team should receive every new lead.
  const assignByBranch = value.assignByBranch === undefined
    ? true
    : value.assignByBranch;
  if (typeof assignByBranch !== "boolean") return null;

  return {
    enabled: value.enabled,
    strategy: "round_robin",
    assignByBranch,
  };
}

module.exports = {
  DEFAULT_LEAD_DISTRIBUTION,
  normalizeLeadDistributionConfig,
};
