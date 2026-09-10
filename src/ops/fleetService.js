const {
  DEFAULT_OFFLINE_AFTER_MS,
  offlineAfterMs: configuredOfflineAfterMs,
} = require("./runtimeConfig");
const {
  LEGACY_CLIENT_LIFECYCLE,
  lifecyclePolicy,
  normalizeClientLifecycle,
} = require("./clientLifecycle");

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

function clientLifecycleStatus(client) {
  return normalizeClientLifecycle(client?.lifecycleStatus, {
    fallback: LEGACY_CLIENT_LIFECYCLE,
  });
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
  offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
} = {}) {
  if (latestPollFailed(client)) return "offline";
  const lifecycle = clientLifecycleStatus(client);
  const knownStatus = lastKnownReadinessStatus(client);

  // Setup/trial/paused deployments can intentionally sleep for long periods.
  // Preserve their last verified readiness rather than calling an intentionally
  // unpolled Free/staging service offline solely because its snapshot is old.
  if (lifecycle !== "live") return knownStatus || "offline";

  const successMs = timestampMs(client.lastSuccessAt);
  if (!successMs || now.getTime() - successMs > offlineAfterMs) return "offline";
  return knownStatus || "offline";
}

function presentClient(client, {
  env = process.env,
  now = new Date(),
  offlineAfterMs = DEFAULT_OFFLINE_AFTER_MS,
} = {}) {
  const lifecycle = lifecyclePolicy(client?.lifecycleStatus, {
    fallback: LEGACY_CLIENT_LIFECYCLE,
  });
  const status = fleetStatus(client, { now, offlineAfterMs });
  const currentCommit = String(env.RENDER_GIT_COMMIT || env.OPS_REGISTRY_COMMIT || "").trim() || null;
  const snapshot = client.lastSnapshot || null;
  const readiness = snapshot?.readiness || null;
  const knownReadinessStatus = lastKnownReadinessStatus(client);
  return {
    clientSlug: client.clientSlug,
    displayName: client.displayName,
    baseUrl: client.baseUrl,
    industry: snapshot?.client?.businessType || client.industry || null,
    purchasedChannels: readiness?.channelContract?.channels
      || client.purchasedChannels
      || [],
    lifecycleStatus: lifecycle.status,
    backgroundPollingEnabled: lifecycle.backgroundPollingEnabled,
    manualRefreshAllowed: lifecycle.manualRefreshAllowed,
    status,
    online: status !== "offline",
    lastKnownReadinessStatus: knownReadinessStatus,
    lastPollAttemptAt: client.lastPollAt,
    lastPollAt: client.lastPollAt,
    lastSuccessAt: client.lastSuccessAt,
    lastError: client.lastError,
    lastHttpStatus: client.lastHttpStatus,
    readiness,
    channels: Array.isArray(readiness?.channels) ? readiness.channels : [],
    blockers: Array.isArray(readiness?.blockers) ? readiness.blockers : [],
    testing: Array.isArray(readiness?.testingRequired) ? readiness.testingRequired : [],
    warnings: Array.isArray(readiness?.warnings) ? readiness.warnings : [],
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
  offlineAfterMs = null,
} = {}) {
  const staleAfterMs = offlineAfterMs == null
    ? configuredOfflineAfterMs(env)
    : offlineAfterMs;
  const refreshes = new Map();

  function present(client) {
    return client ? presentClient(client, { env, now: now(), offlineAfterMs: staleAfterMs }) : null;
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

  function refreshClient(clientSlug, { signal = null } = {}) {
    const existing = refreshes.get(clientSlug);
    if (existing) return existing;

    const refreshPromise = (async () => {
      const client = await repo.getClient(clientSlug);
      if (!client) {
        const err = new Error(`Unknown client: ${clientSlug}`);
        err.code = "OPS_CLIENT_NOT_FOUND";
        throw err;
      }

      const policy = lifecyclePolicy(client.lifecycleStatus, {
        fallback: LEGACY_CLIENT_LIFECYCLE,
      });
      if (!policy.manualRefreshAllowed) {
        const err = new Error(
          `Client ${clientSlug} is paused. Change its lifecycle before refreshing readiness.`,
        );
        err.code = "OPS_CLIENT_PAUSED";
        throw err;
      }

      const polledAt = now();
      try {
        const result = await poller.pollClient(client, { signal });
        await repo.recordPollSuccess(clientSlug, {
          httpStatus: result.httpStatus,
          snapshot: result.snapshot,
          polledAt,
        });
      } catch (err) {
        if (err?.code !== "OPS_POLL_CANCELLED") {
          await repo.recordPollFailure(clientSlug, {
            httpStatus: err?.httpStatus || null,
            error: err?.message || err,
            polledAt,
          });
        }
      }
      return getClient(clientSlug);
    })().finally(() => {
      if (refreshes.get(clientSlug) === refreshPromise) refreshes.delete(clientSlug);
    });

    refreshes.set(clientSlug, refreshPromise);
    return refreshPromise;
  }

  async function refreshAll({ signal = null } = {}) {
    const allClients = await repo.listClients();
    const clients = allClients.filter((client) => lifecyclePolicy(client.lifecycleStatus, {
      fallback: LEGACY_CLIENT_LIFECYCLE,
    }).backgroundPollingEnabled);
    const results = new Array(clients.length);
    const concurrency = Math.max(1, Math.min(4, clients.length || 1));
    let cursor = 0;

    async function worker() {
      while (true) {
        if (signal?.aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= clients.length) return;
        results[index] = await refreshClient(clients[index].clientSlug, { signal });
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const completed = results.filter(Boolean);
    return {
      schemaVersion: 1,
      refreshedAt: now().toISOString(),
      summary: fleetSummary(completed),
      clients: completed,
      refreshedCount: completed.length,
      skippedCount: allClients.length - clients.length,
      cancelled: signal?.aborted === true,
    };
  }

  async function setClientLifecycle(clientSlug, lifecycleStatus) {
    const normalized = normalizeClientLifecycle(lifecycleStatus);
    if (typeof repo.updateLifecycle !== "function") {
      throw new Error("Ops Registry repository does not support lifecycle updates.");
    }
    const updated = await repo.updateLifecycle(clientSlug, normalized);
    if (!updated) {
      const err = new Error(`Unknown client: ${clientSlug}`);
      err.code = "OPS_CLIENT_NOT_FOUND";
      throw err;
    }
    return present(updated);
  }

  return {
    getClient,
    listFleet,
    refreshAll,
    refreshClient,
    setClientLifecycle,
    activeClientRefreshCount: () => refreshes.size,
  };
}

module.exports = {
  OFFLINE_AFTER_MS: DEFAULT_OFFLINE_AFTER_MS,
  READINESS_STATUSES,
  clientLifecycleStatus,
  createFleetService,
  deploymentState,
  fleetStatus,
  fleetSummary,
  lastKnownReadinessStatus,
  latestPollFailed,
  presentClient,
  timestampMs,
};
