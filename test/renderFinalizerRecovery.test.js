const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RenderFinalizationError,
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

test("finalization failure reports exactly which Render mutations already succeeded", async () => {
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/env-vars/PUBLIC_BASE_URL")) return jsonResponse(200, {});
    if (pathname.endsWith("/env-vars/ADMIN_PASSWORD")) return jsonResponse(204);
    if (pathname.endsWith("/deploys")) return jsonResponse(201, { id: "dep-final" });
    throw new Error(`Unexpected request ${pathname} ${options.method || "GET"}`);
  };

  await assert.rejects(
    finalizeRenderRuntime({
      apiKey: "render-key",
      serviceId: "srv-1",
      publicBaseUrl: "https://client.onrender.com",
      fetchImpl,
      renderClient: {
        async waitForDeploy() {
          const err = new Error("deploy dep-final ended with status build_failed");
          err.provider = "Render";
          throw err;
        },
      },
    }),
    (err) => {
      assert.equal(err instanceof RenderFinalizationError, true);
      assert.equal(err.code, "RENDER_RUNTIME_FINALIZATION_FAILED");
      assert.deepEqual(err.partialFinalization, {
        publicBaseUrlConfigured: true,
        adminPasswordRemoved: true,
        deployId: "dep-final",
        deployStatus: "queued",
        deployedCommitSha: null,
      });
      assert.match(err.message, /PUBLIC_BASE_URL was configured/);
      assert.match(err.message, /ADMIN_PASSWORD was removed/);
      assert.match(err.message, /do not reprovision Neon/i);
      return true;
    }
  );
});

test("finalization failure before password cleanup does not claim the password was removed", async () => {
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/env-vars/PUBLIC_BASE_URL")) return jsonResponse(200, {});
    if (pathname.endsWith("/env-vars/ADMIN_PASSWORD")) {
      return jsonResponse(500, { message: "temporary Render failure" });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };

  await assert.rejects(
    finalizeRenderRuntime({
      apiKey: "render-key",
      serviceId: "srv-2",
      publicBaseUrl: "https://client.onrender.com",
      fetchImpl,
      renderClient: { async waitForDeploy() { return { status: "live" }; } },
    }),
    (err) => {
      assert.equal(err.partialFinalization.publicBaseUrlConfigured, true);
      assert.equal(err.partialFinalization.adminPasswordRemoved, false);
      assert.equal(err.partialFinalization.deployId, null);
      assert.match(err.message, /ADMIN_PASSWORD was not confirmed removed/);
      return true;
    }
  );
});
