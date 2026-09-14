const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const previousEnabled = process.env.META_ROUTER_ENABLED;
delete process.env.META_ROUTER_ENABLED;
const {
  DEFAULT_META_ROUTER_MOUNT_PATH,
  normalizeMountPath,
  parseEnabled,
  prepareEmbeddedMetaRouter,
  wrapExpressFactory,
} = require("../src/services/embeddedMetaRouterBootstrap");
if (previousEnabled === undefined) delete process.env.META_ROUTER_ENABLED;
else process.env.META_ROUTER_ENABLED = previousEnabled;

test("embedded Meta router is disabled by default and validates enable flags", () => {
  assert.equal(parseEnabled(undefined), false);
  assert.equal(parseEnabled("false"), false);
  assert.equal(parseEnabled("true"), true);
  assert.equal(parseEnabled("1"), true);
  assert.throws(() => parseEnabled("sometimes"), /Invalid META_ROUTER_ENABLED/i);
});

test("embedded Meta router uses a non-conflicting mount path", () => {
  assert.equal(normalizeMountPath(), DEFAULT_META_ROUTER_MOUNT_PATH);
  assert.equal(normalizeMountPath("/central-meta/"), "/central-meta");
  assert.throws(() => normalizeMountPath("/"), /must not overlap/i);
  assert.throws(() => normalizeMountPath("/webhook/router"), /must not overlap/i);
  assert.throws(() => normalizeMountPath("/meta-webhook/router"), /must not overlap/i);
  assert.throws(() => normalizeMountPath("/api/meta-router"), /must not overlap/i);
});

test("embedded mode requires a dedicated router database credential", () => {
  assert.throws(
    () => prepareEmbeddedMetaRouter({
      env: {
        META_ROUTER_ENABLED: "true",
        OPS_DATABASE_URL: "postgres://ops:secret@localhost:5432/ops",
        META_APP_SECRET: "meta-secret",
        META_VERIFY_TOKEN: "verify-token",
      },
      poolFactory: () => ({ query: async () => ({ rows: [] }) }),
      repoFactory: () => ({}),
      appFactory: () => ({}),
    }),
    /META_ROUTER_DATABASE_URL is required/i,
  );
});

test("embedded mode builds a read-only router mount without running Ops migrations", () => {
  const calls = [];
  const pool = { query: async () => ({ rows: [] }) };
  const repo = { getRoutes: async () => [] };
  const routerApp = { name: "router-app" };
  const env = {
    META_ROUTER_ENABLED: "true",
    META_ROUTER_DATABASE_URL: "postgres://router:secret@localhost:5432/router",
    META_APP_SECRET: "meta-secret",
    META_VERIFY_TOKEN: "verify-token",
  };

  const embedded = prepareEmbeddedMetaRouter({
    env,
    poolFactory(receivedEnv, options) {
      calls.push(["pool", receivedEnv, options]);
      return pool;
    },
    repoFactory(receivedPool) {
      calls.push(["repo", receivedPool]);
      return repo;
    },
    appFactory(options) {
      calls.push(["app", options]);
      return routerApp;
    },
  });

  assert.equal(embedded.mountPath, "/meta-router");
  assert.equal(embedded.callbackPath, "/meta-router/meta-webhook");
  assert.equal(embedded.healthPath, "/meta-router/healthz");
  assert.equal(embedded.pool, pool);
  assert.equal(embedded.repo, repo);
  assert.equal(embedded.routerApp, routerApp);
  assert.deepEqual(calls[0][2], { allowOpsFallback: false });
  assert.equal(calls[1][1], pool);
  assert.equal(calls[2][1].repo, repo);
  assert.equal(typeof calls[2][1].healthCheck, "function");
});

test("Express wrapper mounts the router exactly once and preserves Express statics", () => {
  const routerApp = { name: "router" };
  const createdApps = [];
  function originalExpress() {
    const app = {
      mounts: [],
      use(route, mounted) {
        this.mounts.push([route, mounted]);
      },
    };
    createdApps.push(app);
    return app;
  }
  originalExpress.Router = () => "router-factory";
  originalExpress.json = () => "json-middleware";

  const wrapped = wrapExpressFactory(originalExpress, {
    mountPath: "/meta-router",
    callbackPath: "/meta-router/meta-webhook",
    routerApp,
  });

  const first = wrapped();
  const second = wrapped();
  assert.deepEqual(first.mounts, [["/meta-router", routerApp]]);
  assert.deepEqual(second.mounts, []);
  assert.equal(wrapped.Router, originalExpress.Router);
  assert.equal(wrapped.json, originalExpress.json);
  assert.equal(createdApps.length, 2);
});

test("normal npm start preloads the optional embedded router bootstrap", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  assert.match(
    packageJson.scripts.start,
    /-r \.\/src\/services\/embeddedMetaRouterBootstrap\.js/,
  );
  assert.match(
    packageJson.scripts.dev,
    /-r \.\/src\/services\/embeddedMetaRouterBootstrap\.js/,
  );
});
