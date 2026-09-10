const { Pool } = require("pg");

function parseBoolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
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
  buildOpsPoolConfig,
  createOpsPool,
  parseBoolean,
  withoutConnectionStringSslOptions,
};
