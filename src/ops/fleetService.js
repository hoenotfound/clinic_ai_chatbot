const OFFLINE_AFTER_MS = 15 * 60 * 1000;

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

function fleetStatus(client, {
  now = new Date(),
  offlineAfterMs = OFFLINE_AFTER_MS,
} = {}) {
  const successMs = timestampMs(client.lastSuccessAt);
  if (!successMs || now.getTime() - successMs > offlineAfterMs) return "offline";
  return client.lastStatus || client?.lastSnapshot?.readiness?.status || "offline";
}

function presentClient(client, {
  env = process.env,
  now = new Date(),
  offlineAfterMs = OFFLINE_AFTER_MS,
} = {}) {
  const status = fleetStatus(client, { now, offlineAfterMs });
  const currentCommit = String(env.RENDER_GIT_COMMIT || env.OPS_REGISTRY_COMMIT || "").trim() || null;
  const snapshot = client.lastSnapshot || null;
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
    lastPollAt: client.lastPollAt,
    lastSuccessAt: client.lastSuccessAt,
    lastError: client.lastError,
    lastHttpStatus: client.lastHttpStatus,
    readiness: snapshot?.readiness || null,
    deployment: {
      ...deploymentState(client, currentCommit),
      registryCommit: currentCommit,
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
  async function listFleet() {
    const clients = (await repo.listClients()).map((client) =>
      presentClient(client, { env, now: now(), offlineAfterMs })
    );
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
    const updated = await repo.getClient(clientSlug);
    return presentClient(updated, { env, now: now(), offlineAfterMs });
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
  presentClient,
  timestampMs,
};
