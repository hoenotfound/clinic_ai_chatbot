const {
  ProviderApiError,
  createJsonRequester,
} = require("./providerClients");

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

  await request(`services/${encodedServiceId}/env-vars/PUBLIC_BASE_URL`, {
    method: "PUT",
    body: { value: publicBaseUrl },
  });

  let adminPasswordRemoved = false;
  try {
    await request(`services/${encodedServiceId}/env-vars/ADMIN_PASSWORD`, {
      method: "DELETE",
    });
    adminPasswordRemoved = true;
  } catch (err) {
    if (err instanceof ProviderApiError && err.status === 404) {
      adminPasswordRemoved = true;
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

  const liveDeploy = await renderClient.waitForDeploy(serviceId, deployId);
  return {
    publicBaseUrlConfigured: true,
    adminPasswordRemoved,
    deployId,
    deployStatus: liveDeploy?.status || "live",
    deployedCommitSha: extractRenderCommitSha(liveDeploy),
  };
}

module.exports = {
  extractRenderCommitSha,
  extractRenderDeploy,
  finalizeRenderRuntime,
};