const {
  ProviderApiError,
  createJsonRequester,
} = require("./providerClients");

class RenderFinalizationError extends Error {
  constructor(message, {
    cause = null,
    partialFinalization = null,
  } = {}) {
    super(message);
    this.name = "RenderFinalizationError";
    this.code = "RENDER_RUNTIME_FINALIZATION_FAILED";
    this.cause = cause || null;
    this.partialFinalization = partialFinalization || null;
    this.status = cause?.status || null;
    this.provider = cause?.provider || "Render";
    this.ambiguous = cause?.ambiguous === true;
  }
}

function extractRenderDeploy(payload) {
  return payload?.deploy || payload || null;
}

function extractRenderCommitSha(deploy) {
  const candidates = [
    deploy?.commit?.id,
    deploy?.commit?.sha,
    deploy?.commitId,
    deploy?.commit_id,
    deploy?.gitCommit?.id,
    deploy?.gitCommit?.sha,
  ];
  const value = candidates.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : null;
}

function finalizationStateText(state) {
  return [
    `PUBLIC_BASE_URL ${state.publicBaseUrlConfigured ? "was configured" : "was not confirmed configured"}`,
    `ADMIN_PASSWORD ${state.adminPasswordRemoved ? "was removed" : "was not confirmed removed"}`,
    state.deployId
      ? `final deploy ${state.deployId} was requested${state.deployStatus ? ` and is ${state.deployStatus}` : ""}`
      : "no final deploy ID was confirmed",
  ].join("; ");
}

function wrapFinalizationError(err, state) {
  if (err instanceof RenderFinalizationError) return err;
  const detail = err?.message || "Render runtime finalization failed.";
  return new RenderFinalizationError(
    `Render runtime finalization failed: ${detail} Recovery state: ${finalizationStateText(state)}. Inspect the existing Render service and continue from that state; do not reprovision Neon or create a second service.`,
    {
      cause: err,
      partialFinalization: { ...state },
    }
  );
}

async function finalizeRenderRuntime({
  apiKey,
  serviceId,
  publicBaseUrl,
  renderClient,
  fetchImpl = global.fetch,
  baseUrl = "https://api.render.com/v1/",
} = {}) {
  if (!apiKey) throw new Error("Render finalization requires PROVISIONING_RENDER_API_KEY.");
  if (!serviceId) throw new Error("Render finalization requires a service ID.");
  if (!publicBaseUrl) throw new Error("Render finalization requires the deployed public URL.");
  if (!renderClient || typeof renderClient.waitForDeploy !== "function") {
    throw new Error("Render finalization requires the provisioning Render client.");
  }

  const request = createJsonRequester({
    provider: "Render",
    baseUrl,
    token: apiKey,
    fetchImpl,
  });
  const encodedServiceId = encodeURIComponent(serviceId);
  const state = {
    publicBaseUrlConfigured: false,
    adminPasswordRemoved: false,
    deployId: null,
    deployStatus: null,
    deployedCommitSha: null,
  };

  try {
    await request(`services/${encodedServiceId}/env-vars/PUBLIC_BASE_URL`, {
      method: "PUT",
      body: { value: publicBaseUrl },
    });
    state.publicBaseUrlConfigured = true;

    try {
      await request(`services/${encodedServiceId}/env-vars/ADMIN_PASSWORD`, {
        method: "DELETE",
      });
      state.adminPasswordRemoved = true;
    } catch (err) {
      if (err instanceof ProviderApiError && err.status === 404) {
        state.adminPasswordRemoved = true;
      } else {
        throw err;
      }
    }

    const deployPayload = await request(`services/${encodedServiceId}/deploys`, {
      method: "POST",
      body: { clearCache: "do_not_clear" },
    });
    const queuedDeploy = extractRenderDeploy(deployPayload);
    const deployId = queuedDeploy?.id;
    if (!deployId) {
      throw new ProviderApiError(
        "Render",
        "runtime finalization deploy response did not include a deploy ID",
        {
          method: "POST",
          path: `/services/${serviceId}/deploys`,
          ambiguous: true,
        }
      );
    }
    state.deployId = deployId;
    state.deployStatus = String(queuedDeploy?.status || "queued").toLowerCase();

    const liveDeploy = await renderClient.waitForDeploy(serviceId, deployId);
    state.deployStatus = String(liveDeploy?.status || "live").toLowerCase();
    state.deployedCommitSha = extractRenderCommitSha(liveDeploy);
    return { ...state };
  } catch (err) {
    throw wrapFinalizationError(err, state);
  }
}

module.exports = {
  RenderFinalizationError,
  extractRenderCommitSha,
  extractRenderDeploy,
  finalizationStateText,
  finalizeRenderRuntime,
  wrapFinalizationError,
};
