const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractRenderCommitSha,
  finalizeRenderRuntime,
} = require("../src/provisioning/renderFinalizer");

function jsonResponse(status, body = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === null ? "" : JSON.stringify(body);
    },
  };
}

test("Render finalization sets PUBLIC_BASE_URL, removes ADMIN_PASSWORD and deploys the cleanup", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: options.method, body: options.body });
    if (pathname.endsWith("/env-vars/PUBLIC_BASE_URL")) {
      assert.equal(options.method, "PUT");
      assert.deepEqual(JSON.parse(options.body), { value: "https://client.onrender.com" });
      return jsonResponse(200, { key: "PUBLIC_BASE_URL", value: "https://client.onrender.com" });
    }
    if (pathname.endsWith("/env-vars/ADMIN_PASSWORD")) {
      assert.equal(options.method, "DELETE");
      return jsonResponse(204);
    }
    if (pathname.endsWith("/deploys")) {
      assert.equal(options.method, "POST");
      return jsonResponse(201, { id: "dep-final" });
    }
    throw new Error(`Unexpected Render request ${pathname}`);
  };
  const renderClient = {
    async waitForDeploy(serviceId, deployId) {
      assert.equal(serviceId, "srv-1");
      assert.equal(deployId, "dep-final");
      return {
        id: deployId,
        status: "live",
        commit: { id: "0123456789abcdef" },
      };
    },
  };

  const result = await finalizeRenderRuntime({
    apiKey: "render-key",
    serviceId: "srv-1",
    publicBaseUrl: "https://client.onrender.com",
    renderClient,
    fetchImpl,
  });

  assert.equal(result.publicBaseUrlConfigured, true);
  assert.equal(result.adminPasswordRemoved, true);
  assert.equal(result.deployId, "dep-final");
  assert.equal(result.deployStatus, "live");
  assert.equal(result.deployedCommitSha, "0123456789abcdef");
  assert.deepEqual(calls.map((call) => call.method), ["PUT", "DELETE", "POST"]);
});

test("Render finalization treats an already-absent ADMIN_PASSWORD as cleaned up", async () => {
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/env-vars/PUBLIC_BASE_URL")) return jsonResponse(200, {});
    if (pathname.endsWith("/env-vars/ADMIN_PASSWORD")) {
      return jsonResponse(404, { message: "not found" });
    }
    if (pathname.endsWith("/deploys")) return jsonResponse(201, { deploy: { id: "dep-2" } });
    throw new Error(`Unexpected Render request ${pathname}`);
  };
  const result = await finalizeRenderRuntime({
    apiKey: "render-key",
    serviceId: "srv-2",
    publicBaseUrl: "https://client.onrender.com",
    renderClient: {
      async waitForDeploy() {
        return { status: "live", commitId: "fedcba9876543210" };
      },
    },
    fetchImpl,
  });

  assert.equal(result.adminPasswordRemoved, true);
  assert.equal(result.deployedCommitSha, "fedcba9876543210");
});

test("commit SHA extraction accepts current and compatibility Render deploy shapes", () => {
  assert.equal(extractRenderCommitSha({ commit: { id: "a" } }), "a");
  assert.equal(extractRenderCommitSha({ commit: { sha: "b" } }), "b");
  assert.equal(extractRenderCommitSha({ commitId: "c" }), "c");
  assert.equal(extractRenderCommitSha({ gitCommit: { sha: "d" } }), "d");
  assert.equal(extractRenderCommitSha({}), null);
});