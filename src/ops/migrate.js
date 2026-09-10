const { createOpsPool } = require("./db");
const { runOpsMigrations } = require("./migrationRunner");
const { assertOpsRegistryMode } = require("./mode");

async function main() {
  assertOpsRegistryMode();
  const pool = createOpsPool();
  try {
    const applied = await runOpsMigrations(pool);
    if (applied.length) {
      console.log(`Applied ${applied.length} Ops Registry migration(s).`);
    } else {
      console.log("Ops Registry schema is already current.");
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { main };
