const { Pool } = require("pg");

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const DEFAULT_QUERY_TIMEOUT_MS = 10000;
const DEFAULT_POOL_MAX = 5;

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function withoutConnectionStringSslOptions(connectionString) {
  const url = new URL(connectionString);
  // node-postgres connection-string SSL parameters can replace the explicit
  // ssl object. Remove them so OPS_DATABASE_SSL_REJECT_UNAUTHORIZED has one
  // predictable source of truth.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

function buildOpsPoolConfig(env = process.env) {
  const connectionString = String(env.OPS_DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("OPS_DATABASE_URL is required for the multi-client operations registry.");
  }

  const parsed = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("OPS_DATABASE_URL must be a PostgreSQL connection string.");
  }

  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const rejectUnauthorized = parseBoolean(
    env.OPS_DATABASE_SSL_REJECT_UNAUTHORIZED,
    true,
  );

  return {
    connectionString: local ? connectionString : withoutConnectionStringSslOptions(connectionString),
    ssl: local ? false : { rejectUnauthorized },
    application_name: "da-chatbot-ops-registry",
    connectionTimeoutMillis: boundedPositiveInteger(
      env.OPS_DATABASE_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
      { min: 1000, max: 30_000 },
    ),
    query_timeout: boundedPositiveInteger(
      env.OPS_DATABASE_QUERY_TIMEOUT_MS,
      DEFAULT_QUERY_TIMEOUT_MS,
      { min: 1000, max: 60_000 },
    ),
    max: boundedPositiveInteger(
      env.OPS_DATABASE_POOL_MAX,
      DEFAULT_POOL_MAX,
      { min: 1, max: 20 },
    ),
    idleTimeoutMillis: 30_000,
  };
}

function createOpsPool(env = process.env) {
  const pool = new Pool(buildOpsPoolConfig(env));
  pool.on("error", (err) => {
    console.error("Unexpected Ops Registry Postgres pool error:", err);
  });
  return pool;
}

module.exports = {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_POOL_MAX,
  DEFAULT_QUERY_TIMEOUT_MS,
  boundedPositiveInteger,
  buildOpsPoolConfig,
  createOpsPool,
  parseBoolean,
  withoutConnectionStringSslOptions,
};
