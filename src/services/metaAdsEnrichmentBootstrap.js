require("dotenv").config();

const { pool } = require("../db/db");
const { start } = require("./metaAdsEnrichmentService");

let workerStarted = false;

async function startWhenSchemaIsReady() {
  if (workerStarted || !process.env.META_MARKETING_ACCESS_TOKEN) return;
  try {
    // Preloads run before server.js calls initSchema(). Wait for PR #65/#66's
    // attribution table to exist so a deploy never fails just because this
    // background worker started a fraction of a second before schema setup.
    await pool.query(`SELECT 1 FROM lead_attributions LIMIT 1`);
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
