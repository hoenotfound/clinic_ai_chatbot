const { Pool } = require("pg");
const { buildOpsPoolConfig } = require("../ops/db");

function text(value) {
  return String(value || "").trim();
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function routerDatabaseEnv(env = process.env, { allowOpsFallback = true } = {}) {
  const routerUrl = text(env.META_ROUTER_DATABASE_URL);
  const opsUrl = allowOpsFallback ? text(env.OPS_DATABASE_URL) : "";
  const connectionString = routerUrl || opsUrl;

  if (!connectionString) {
    throw new Error(
      allowOpsFallback
        ? "META_ROUTER_DATABASE_URL (preferred) or OPS_DATABASE_URL is required by the Meta webhook router."
        : "META_ROUTER_DATABASE_URL is required when the Meta router is embedded in a client deployment."
    );
  }

  return {
    ...env,
    OPS_DATABASE_URL: connectionString,
    OPS_DATABASE_SSL_REJECT_UNAUTHORIZED: firstDefined(
      env.META_ROUTER_DATABASE_SSL_REJECT_UNAUTHORIZED,
      env.OPS_DATABASE_SSL_REJECT_UNAUTHORIZED,
    ),
    OPS_DATABASE_CONNECTION_TIMEOUT_MS: firstDefined(
      env.META_ROUTER_DATABASE_CONNECTION_TIMEOUT_MS,
      env.OPS_DATABASE_CONNECTION_TIMEOUT_MS,
    ),
    OPS_DATABASE_QUERY_TIMEOUT_MS: firstDefined(
      env.META_ROUTER_DATABASE_QUERY_TIMEOUT_MS,
      env.OPS_DATABASE_QUERY_TIMEOUT_MS,
    ),
    OPS_DATABASE_POOL_MAX: firstDefined(
      env.META_ROUTER_DATABASE_POOL_MAX,
      env.OPS_DATABASE_POOL_MAX,
      3,
    ),
  };
}

function buildMetaRouterPoolConfig(env = process.env, options = {}) {
  return {
    ...buildOpsPoolConfig(routerDatabaseEnv(env, options)),
    application_name: "da-chatbot-meta-router",
  };
}

function createMetaRouterPool(env = process.env, options = {}) {
  const pool = new Pool(buildMetaRouterPoolConfig(env, options));
  pool.on("error", (err) => {
    console.error("Unexpected Meta Router Postgres pool error:", err);
  });
  return pool;
}

module.exports = {
  buildMetaRouterPoolConfig,
  createMetaRouterPool,
  firstDefined,
  routerDatabaseEnv,
  text,
};
