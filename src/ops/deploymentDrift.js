const DRIFT_STATUSES = Object.freeze({
  CURRENT: "current",
  DRIFTED: "drifted",
  UNKNOWN: "unknown",
});

const TARGET_SOURCES = Object.freeze({
  CONFIGURED: "configured",
  REGISTRY_DEPLOYMENT: "registry_deployment",
  UNAVAILABLE: "unavailable",
});

function normalizeCommit(value) {
  return String(value || "").trim() || null;
}

function sameCommit(left, right) {
  const a = normalizeCommit(left);
  const b = normalizeCommit(right);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function resolveFleetTarget(env = process.env) {
  const configured = normalizeCommit(env.OPS_FLEET_TARGET_COMMIT);
  if (configured) {
    return {
      commitSha: configured,
      source: TARGET_SOURCES.CONFIGURED,
    };
  }

  const registryCommit = normalizeCommit(env.RENDER_GIT_COMMIT || env.OPS_REGISTRY_COMMIT);
  if (registryCommit) {
    return {
      commitSha: registryCommit,
      source: TARGET_SOURCES.REGISTRY_DEPLOYMENT,
    };
  }

  return {
    commitSha: null,
    source: TARGET_SOURCES.UNAVAILABLE,
  };
}

function observedCommit(client) {
  return normalizeCommit(client?.lastSnapshot?.deployment?.commitSha);
}

function provisionedCommit(client) {
  return normalizeCommit(client?.provisionedCommitSha);
}

function driftForClient(client, target = {}) {
  const observed = observedCommit(client);
  const provisioned = provisionedCommit(client);
  const targetCommit = normalizeCommit(target.commitSha);
  let driftStatus = DRIFT_STATUSES.UNKNOWN;

  if (observed && targetCommit) {
    driftStatus = sameCommit(observed, targetCommit)
      ? DRIFT_STATUSES.CURRENT
      : DRIFT_STATUSES.DRIFTED;
  }

  return {
    driftStatus,
    observedCommit: observed,
    targetCommit,
    targetSource: target.source || TARGET_SOURCES.UNAVAILABLE,
    provisionedCommit: provisioned,
    changedSinceProvisioning: observed && provisioned
      ? !sameCommit(observed, provisioned)
      : null,
  };
}

function deploymentDriftSummary(clients = [], target = {}) {
  const summary = {
    total: clients.length,
    current: 0,
    drifted: 0,
    unknown: 0,
    targetCommit: normalizeCommit(target.commitSha),
    targetSource: target.source || TARGET_SOURCES.UNAVAILABLE,
  };

  for (const client of clients) {
    const status = client?.deployment?.driftStatus || DRIFT_STATUSES.UNKNOWN;
    if (status === DRIFT_STATUSES.CURRENT) summary.current += 1;
    else if (status === DRIFT_STATUSES.DRIFTED) summary.drifted += 1;
    else summary.unknown += 1;
  }

  return summary;
}

module.exports = {
  DRIFT_STATUSES,
  TARGET_SOURCES,
  deploymentDriftSummary,
  driftForClient,
  normalizeCommit,
  observedCommit,
  provisionedCommit,
  resolveFleetTarget,
  sameCommit,
};
