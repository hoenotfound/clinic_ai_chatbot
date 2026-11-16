require("dotenv").config();
const { lifecycle } = require("../utils/migrationLifecycle");

const { pool } = require("../db/db");
const { start } = require("./metaAdsEnrichmentService");

let workerStarted = false;

async function startWhenSchemaIsReady() {
  if (!lifecycle.accepting() || workerStarted || !process.env.META_MARKETING_ACCESS_TOKEN) return;
  try {
    // Preloads run before server.js calls initSchema(). A database that already
    // deployed PR #65 can have lead_attributions before the enrichment columns
    // exist, so probe a #67 column rather than only probing the table itself.
    // This prevents the worker's first sweep from racing the startup migration.
    await pool.query(`SELECT enrichment_status FROM lead_attributions LIMIT 0`);
    if (workerStarted) return;
    workerStarted = true;
    start();
  } catch (err) {
    console.warn(
      "Meta Ads enrichment worker is waiting for database schema:",
      err?.message || err
    );
    const retryTimer = setTimeout(runStartup, 5000);
    lifecycle.registerStop(retryTimer, () => clearTimeout(retryTimer));
    retryTimer.unref?.();
  }
}

function runStartup() {
  if (!lifecycle.accepting()) return;
  return lifecycle.run("Meta enrichment startup", startWhenSchemaIsReady);
}
const startTimer = setTimeout(runStartup, 1000);
lifecycle.registerStop(startTimer, () => clearTimeout(startTimer));
startTimer.unref?.();
