require("dotenv").config();

const { createMetaRouterPool } = require("../metaRouter/db");
const { createMetaWebhookRouteRepo } = require("../metaRouter/routeRepo");
const { createMetaRouterApp } = require("../metaRouter/server");

const DEFAULT_META_ROUTER_MOUNT_PATH = "/meta-router";

function text(value) {
  return String(value || "").trim();
}

function parseEnabled(value) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid META_ROUTER_ENABLED value: ${value}`);
}

function normalizeMountPath(value) {
  const raw = text(value) || DEFAULT_META_ROUTER_MOUNT_PATH;
  if (!raw.startsWith("/") || raw.includes("?") || raw.includes("#")) {
    throw new Error("META_ROUTER_MOUNT_PATH must be an absolute URL path without query/hash components.");
  }

  const normalized = raw.replace(/\/+$/, "") || "/";
  const reserved = ["/", "/webhook", "/meta-webhook", "/api"];
  if (
    reserved.includes(normalized) ||
    normalized.startsWith("/webhook/") ||
    normalized.startsWith("/meta-webhook/") ||
    normalized.startsWith("/api/")
  ) {
    throw new Error(
      "META_ROUTER_MOUNT_PATH must not overlap the chatbot's WhatsApp, social, or API routes."
    );
  }
  return normalized;
}

function prepareEmbeddedMetaRouter({
  env = process.env,
  poolFactory = createMetaRouterPool,
  repoFactory = createMetaWebhookRouteRepo,
  appFactory = createMetaRouterApp,
} = {}) {
  if (!parseEnabled(env.META_ROUTER_ENABLED)) return null;

  // Embedded mode intentionally does not fall back to OPS_DATABASE_URL. The
  // anchor client should receive a dedicated read-only database credential
  // with SELECT access to meta_webhook_routes, not full Ops Registry access.
  if (!text(env.META_ROUTER_DATABASE_URL)) {
    throw new Error(
      "META_ROUTER_DATABASE_URL is required when META_ROUTER_ENABLED=true. " +
      "Use a read-only credential for the routing table; do not put OPS_DATABASE_URL on a client deployment."
    );
  }

  const mountPath = normalizeMountPath(env.META_ROUTER_MOUNT_PATH);
  const pool = poolFactory(env, { allowOpsFallback: false });
  const repo = repoFactory(pool);
  const routerApp = appFactory({
    repo,
    env,
    healthCheck: () => pool.query("SELECT 1"),
  });

  return {
    mountPath,
    pool,
    repo,
    routerApp,
    callbackPath: `${mountPath}/meta-webhook`,
    healthPath: `${mountPath}/healthz`,
  };
}

function copyExpressStatics(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    if (["length", "name", "prototype", "arguments", "caller"].includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch (_) {
      // Express exposes only normal configurable statics today. Ignore a future
      // non-configurable addition instead of changing the app factory behavior.
    }
  }
  return target;
}

function wrapExpressFactory(originalExpress, embedded) {
  if (typeof originalExpress !== "function") {
    throw new Error("Embedded Meta router requires the Express application factory.");
  }
  if (!embedded?.routerApp || !embedded?.mountPath) {
    throw new Error("Embedded Meta router mount information is incomplete.");
  }

  let mounted = false;
  function wrappedExpress(...args) {
    const app = originalExpress(...args);
    if (!mounted) {
      app.use(embedded.mountPath, embedded.routerApp);
      mounted = true;
      console.log(
        `[Startup] Embedded Meta router mounted at ${embedded.callbackPath || `${embedded.mountPath}/meta-webhook`}.`
      );
    }
    return app;
  }

  copyExpressStatics(wrappedExpress, originalExpress);
  return wrappedExpress;
}

function installEmbeddedMetaRouter({
  env = process.env,
  requireImpl = require,
  cache = require.cache,
  resolveImpl = require.resolve,
} = {}) {
  if (!parseEnabled(env.META_ROUTER_ENABLED)) return null;

  const embedded = prepareEmbeddedMetaRouter({ env });
  const expressModulePath = resolveImpl("express");
  const originalExpress = requireImpl("express");
  const moduleRecord = cache[expressModulePath];
  if (!moduleRecord) {
    throw new Error("Express module cache entry was not available for Meta router bootstrap.");
  }

  moduleRecord.exports = wrapExpressFactory(originalExpress, embedded);
  return embedded;
}

if (parseEnabled(process.env.META_ROUTER_ENABLED)) {
  installEmbeddedMetaRouter();
}

module.exports = {
  DEFAULT_META_ROUTER_MOUNT_PATH,
  copyExpressStatics,
  installEmbeddedMetaRouter,
  normalizeMountPath,
  parseEnabled,
  prepareEmbeddedMetaRouter,
  wrapExpressFactory,
};
