require("dotenv").config();

const { pool } = require("../db/db");
const { start } = require("./metaAdsEnrichmentService");

let workerStarted = false;

async function startWhenSchemaIsReady() {
  if (workerStarted || !process.env.META_MARKETING_ACCESS_TOKEN) return;
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
    const retryTimer = setTimeout(startWhenSchemaIsReady, 5000);
    retryTimer.unref?.();
  }
}

const startTimer = setTimeout(startWhenSchemaIsReady, 1000);
startTimer.unref?.();
