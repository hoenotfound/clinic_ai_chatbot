const { Pool } = require("pg");

function buildOpsPoolConfig(env = process.env) {
  const connectionString = String(env.OPS_DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("OPS_DATABASE_URL is required for the multi-client operations registry.");
  }

  const local = /^postgres(?:ql)?:\/\/[^/]*(?:localhost|127\.0\.0\.1)/i.test(connectionString);
  return {
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
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
};
