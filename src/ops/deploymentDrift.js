const DRIFT_STATUSES = Object.freeze({
  CURRENT: "current",
  DRIFTED: "drifted",
  UNKNOWN: "unknown",
});

const DRIFT_REASONS = Object.freeze({
  MATCHES_TARGET: "matches_target",
  DIFFERS_FROM_TARGET: "differs_from_target",
  TARGET_UNAVAILABLE: "target_unavailable",
  TARGET_INVALID: "target_invalid",
  OBSERVATION_UNAVAILABLE: "observation_unavailable",
  OBSERVATION_INVALID: "observation_invalid",
});

const TARGET_SOURCES = Object.freeze({
  CONFIGURED: "configured",
  REGISTRY_DEPLOYMENT: "registry_deployment",
  UNAVAILABLE: "unavailable",
});

const TARGET_VALIDITY = Object.freeze({
  VALID: "valid",
  INVALID: "invalid",
  UNAVAILABLE: "unavailable",
});

const FULL_GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function normalizeCommit(value) {
  return String(value || "").trim() || null;
}

function isFullCommitSha(value) {
  const normalized = normalizeCommit(value);
  return Boolean(normalized && FULL_GIT_SHA_RE.test(normalized));
}

function normalizeFullCommit(value) {
  const normalized = normalizeCommit(value);
  return isFullCommitSha(normalized) ? normalized : null;
}

function sameCommit(left, right) {
  const a = normalizeCommit(left);
  const b = normalizeCommit(right);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function validatedTarget(rawValue, source, invalidLabel) {
  const raw = normalizeCommit(rawValue);
  if (!raw) {
    return {
      commitSha: null,
      source: TARGET_SOURCES.UNAVAILABLE,
      validity: TARGET_VALIDITY.UNAVAILABLE,
      error: null,
    };
  }

  if (!isFullCommitSha(raw)) {
    return {
      commitSha: null,
      source,
      validity: TARGET_VALIDITY.INVALID,
      error: `${invalidLabel} must be a full 40- or 64-character hexadecimal Git commit SHA.`,
    };
  }

  return {
    commitSha: raw,
    source,
    validity: TARGET_VALIDITY.VALID,
    error: null,
  };
}

function resolveFleetTarget(env = process.env) {
  const configured = normalizeCommit(env.OPS_FLEET_TARGET_COMMIT);
  if (configured) {
    return validatedTarget(
      configured,
      TARGET_SOURCES.CONFIGURED,
      "OPS_FLEET_TARGET_COMMIT",
    );
  }

  const registryCommit = normalizeCommit(env.RENDER_GIT_COMMIT || env.OPS_REGISTRY_COMMIT);
  if (registryCommit) {
    return validatedTarget(
      registryCommit,
      TARGET_SOURCES.REGISTRY_DEPLOYMENT,
      "Registry deployment commit",
    );
  }

  return {
    commitSha: null,
    source: TARGET_SOURCES.UNAVAILABLE,
    validity: TARGET_VALIDITY.UNAVAILABLE,
    error: null,
  };
}

function observedCommit(client) {
  return normalizeCommit(client?.lastSnapshot?.deployment?.commitSha);
}

function provisionedCommit(client) {
  return normalizeCommit(client?.provisionedCommitSha);
}

function targetValidity(target = {}) {
  if (target.validity === TARGET_VALIDITY.VALID
    || target.validity === TARGET_VALIDITY.INVALID
    || target.validity === TARGET_VALIDITY.UNAVAILABLE) {
    return target.validity;
  }

  const raw = normalizeCommit(target.commitSha);
  if (!raw) return TARGET_VALIDITY.UNAVAILABLE;
  return isFullCommitSha(raw) ? TARGET_VALIDITY.VALID : TARGET_VALIDITY.INVALID;
}

function driftForClient(client, target = {}) {
  const observed = observedCommit(client);
  const observedValidated = normalizeFullCommit(observed);
  const provisioned = provisionedCommit(client);
  const provisionedValidated = normalizeFullCommit(provisioned);
  const targetCommit = normalizeFullCommit(target.commitSha);
  const validity = targetValidity(target);

  let driftStatus = DRIFT_STATUSES.UNKNOWN;
  let driftReason = DRIFT_REASONS.TARGET_UNAVAILABLE;

  if (validity === TARGET_VALIDITY.INVALID) {
    driftReason = DRIFT_REASONS.TARGET_INVALID;
  } else if (!targetCommit) {
    driftReason = DRIFT_REASONS.TARGET_UNAVAILABLE;
  } else if (!observed) {
    driftReason = DRIFT_REASONS.OBSERVATION_UNAVAILABLE;
  } else if (!observedValidated) {
    driftReason = DRIFT_REASONS.OBSERVATION_INVALID;
  } else if (sameCommit(observedValidated, targetCommit)) {
    driftStatus = DRIFT_STATUSES.CURRENT;
    driftReason = DRIFT_REASONS.MATCHES_TARGET;
  } else {
    driftStatus = DRIFT_STATUSES.DRIFTED;
    driftReason = DRIFT_REASONS.DIFFERS_FROM_TARGET;
  }

  return {
    driftStatus,
    driftReason,
    observedCommit: observed,
    observedCommitValid: observed == null ? null : Boolean(observedValidated),
    targetCommit,
    targetSource: target.source || TARGET_SOURCES.UNAVAILABLE,
    targetValidity: validity,
    targetError: target.error || null,
    provisionedCommit: provisioned,
    provisionedCommitValid: provisioned == null ? null : Boolean(provisionedValidated),
    changedSinceProvisioning: observedValidated && provisionedValidated
      ? !sameCommit(observedValidated, provisionedValidated)
      : null,
  };
}

function deploymentDriftSummary(clients = [], target = {}) {
  const validity = targetValidity(target);
  const summary = {
    total: clients.length,
    current: 0,
    drifted: 0,
    unknown: 0,
    targetCommit: normalizeFullCommit(target.commitSha),
    targetSource: target.source || TARGET_SOURCES.UNAVAILABLE,
    targetValidity: validity,
    targetError: target.error || null,
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
  DRIFT_REASONS,
  DRIFT_STATUSES,
  FULL_GIT_SHA_RE,
  TARGET_SOURCES,
  TARGET_VALIDITY,
  deploymentDriftSummary,
  driftForClient,
  isFullCommitSha,
  normalizeCommit,
  normalizeFullCommit,
  observedCommit,
  provisionedCommit,
  resolveFleetTarget,
  sameCommit,
  targetValidity,
};
