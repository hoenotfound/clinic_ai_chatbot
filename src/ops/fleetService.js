const OFFLINE_AFTER_MS = 15 * 60 * 1000;
const READINESS_STATUSES = new Set([
  "ready",
  "ready_with_warnings",
  "needs_testing",
  "blocked",
]);

function timestampMs(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function deploymentState(client, currentCommit) {
  const deployed = client?.lastSnapshot?.deployment?.commitSha
    || client?.provisionedCommitSha
    || null;
  if (!deployed || !currentCommit) return { state: "unknown", deployedCommit: deployed };
  return {
    state: deployed === currentCommit ? "current" : "different",
    deployedCommit: deployed,
  };
}

function latestPollFailed(client) {
  if (!client?.lastError) return false;
  const pollMs = timestampMs(client.lastPollAt);
  const successMs = timestampMs(client.lastSuccessAt);
  if (!pollMs) return true;
  return !successMs || pollMs >= successMs;
}

function lastKnownReadinessStatus(client) {
  const status = client?.lastStatus || client?.lastSnapshot?.readiness?.status || null;
  return READINESS_STATUSES.has(status) ? status : null;
}

function fleetStatus(client, {
  now = new Date(),
  offlineAfterMs = OFFLINE_AFTER_MS,
} = {}) {
  if (latestPollFailed(client)) return "offline";
  const successMs = timestampMs(client.lastSuccessAt);
  if (!successMs || now.getTime() - successMs > offlineAfterMs) return "offline";
  return lastKnownReadinessStatus(client) || "offline";
}

function presentClient(client, {
  env = process.env,
  now = new Date(),
  offlineAfterMs = OFFLINE_AFTER_MS,
} = {}) {
  const status = fleetStatus(client, { now, offlineAfterMs });
  const currentCommit = String(env.RENDER_GIT_COMMIT || env.OPS_REGISTRY_COMMIT || "").trim() || null;
  const snapshot = client.lastSnapshot || null;
  const knownReadinessStatus = lastKnownReadinessStatus(client);
  return {
    clientSlug: client.clientSlug,
    displayName: client.displayName,
    baseUrl: client.baseUrl,
    industry: snapshot?.client?.businessType || client.industry || null,
    purchasedChannels: snapshot?.readiness?.channelContract?.channels
      || client.purchasedChannels
      || [],
    status,
    online: status !== "offline",
    lastKnownReadinessStatus: knownReadinessStatus,
    lastPollAttemptAt: client.lastPollAt,
    lastPollAt: client.lastPollAt,
    lastSuccessAt: client.lastSuccessAt,
    lastError: client.lastError,
    lastHttpStatus: client.lastHttpStatus,
    readiness: snapshot?.readiness || null,
    channels: Array.isArray(snapshot?.channels) ? snapshot.channels : [],
    blockers: Array.isArray(snapshot?.blockers) ? snapshot.blockers : [],
    testing: Array.isArray(snapshot?.testing) ? snapshot.testing : [],
    warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
    deployment: {
      ...deploymentState(client, currentCommit),
      registryCommit: currentCommit,
      startedAt: snapshot?.deployment?.startedAt || null,
      appVersion: snapshot?.deployment?.appVersion || null,
    },
    render: client.render,
    neon: client.neon,
    tokenConfigured: Boolean(String(env[client.tokenEnvKey] || "").trim()),
  };
}

function fleetSummary(clients = []) {
  const counts = {
    total: clients.length,
    ready: 0,
    ready_with_warnings: 0,
    needs_testing: 0,
    blocked: 0,
    offline: 0,
  };
  for (const client of clients) {
    if (Object.prototype.hasOwnProperty.call(counts, client.status)) counts[client.status] += 1;
    else counts.offline += 1;
  }
  return counts;
}

function createFleetService({
  repo,
  poller,
  env = process.env,
  now = () => new Date(),
  offlineAfterMs = OFFLINE_AFTER_MS,
} = {}) {
  function present(client) {
    return client ? presentClient(client, { env, now: now(), offlineAfterMs }) : null;
  }

  async function getClient(clientSlug) {
    return present(await repo.getClient(clientSlug));
  }

  async function listFleet() {
    const clients = (await repo.listClients()).map(present);
    return {
      schemaVersion: 1,
      generatedAt: now().toISOString(),
      summary: fleetSummary(clients),
      clients,
    };
  }

  async function refreshClient(clientSlug) {
    const client = await repo.getClient(clientSlug);
    if (!client) {
      const err = new Error(`Unknown client: ${clientSlug}`);
      err.code = "OPS_CLIENT_NOT_FOUND";
      throw err;
    }

    const polledAt = now();
    try {
      const result = await poller.pollClient(client);
      await repo.recordPollSuccess(clientSlug, {
        httpStatus: result.httpStatus,
        snapshot: result.snapshot,
        polledAt,
      });
    } catch (err) {
      await repo.recordPollFailure(clientSlug, {
        httpStatus: err?.httpStatus || null,
        error: err?.message || err,
        polledAt,
      });
    }
    return getClient(clientSlug);
  }

  async function refreshAll() {
    const clients = await repo.listClients();
    const results = new Array(clients.length);
    const concurrency = Math.max(1, Math.min(4, clients.length || 1));
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= clients.length) return;
        results[index] = await refreshClient(clients[index].clientSlug);
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return {
      schemaVersion: 1,
      refreshedAt: now().toISOString(),
      summary: fleetSummary(results),
      clients: results,
    };
  }

  return {
    getClient,
    listFleet,
    refreshAll,
    refreshClient,
  };
}

module.exports = {
  OFFLINE_AFTER_MS,
  createFleetService,
  deploymentState,
  fleetStatus,
  fleetSummary,
  lastKnownReadinessStatus,
  latestPollFailed,
  presentClient,
  timestampMs,
};
