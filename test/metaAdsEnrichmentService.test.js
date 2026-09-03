const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CONFIGURATION_ERROR_DELAY_MS,
  createMetaAdsEnrichmentService,
  retryDelayMs,
} = require("../src/services/metaAdsEnrichmentService");

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

test("successful enrichment persists Meta hierarchy and refreshes Pipeline", async () => {
  const calls = [];
  const repo = {
    async markMetaEnrichmentSuccess(id, details) {
      calls.push(["success", id, details]);
      return { id, lead_id: 44, enrichment_status: "enriched" };
    },
    async markMetaEnrichmentDeferred() {
      throw new Error("should not defer");
    },
  };
  const api = {
    configured: () => true,
    async fetchAdDetails(adId) {
      calls.push(["fetch", adId]);
      return {
        adId,
        adName: "HIFU Doctor Video V3",
        accountId: "123",
        adsetId: "456",
        adsetName: "Women 25-45 KL",
        campaignId: "789",
        campaignName: "HIFU September Sales",
      };
    },
  };
  const events = {
    publish(type, payload) {
      calls.push(["event", type, payload]);
    },
  };

  const service = createMetaAdsEnrichmentService({ repo, api, events, logger: silentLogger() });
  const result = await service.processClaimed({
    id: 9,
    lead_id: 44,
    meta_ad_id: "120210000001234",
    enrichment_attempts: 1,
  });

  assert.equal(result.status, "enriched");
  assert.deepEqual(calls[0], ["fetch", "120210000001234"]);
  assert.equal(calls[1][0], "success");
  assert.deepEqual(calls[2], [
    "event",
    "pipeline_changed",
    { leadId: 44, reason: "meta_ad_enriched" },
  ]);
});

test("API failures are deferred without throwing into the chatbot path", async () => {
  const deferred = [];
  const repo = {
    async markMetaEnrichmentSuccess() {
      throw new Error("should not succeed");
    },
    async markMetaEnrichmentDeferred(id, message, delayMs) {
      deferred.push({ id, message, delayMs });
      return { id };
    },
  };
  const api = {
    configured: () => true,
    async fetchAdDetails() {
      const err = new Error("Meta temporarily unavailable");
      err.retryable = true;
      err.code = 2;
      throw err;
    },
  };

  const service = createMetaAdsEnrichmentService({
    repo,
    api,
    events: { publish() {} },
    logger: silentLogger(),
  });
  const result = await service.processClaimed({
    id: 11,
    meta_ad_id: "120210000001234",
    enrichment_attempts: 2,
  });

  assert.equal(result.status, "deferred");
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].id, 11);
  assert.match(deferred[0].message, /Meta temporarily unavailable/);
  assert.equal(deferred[0].delayMs, 5 * 60 * 1000);
});

test("a credential failure stops the sweep from hammering every claimed ad", async () => {
  const fetched = [];
  const deferred = [];
  const repo = {
    async claimMetaEnrichmentBatch() {
      return [
        { id: 1, meta_ad_id: "1001", enrichment_attempts: 1 },
        { id: 2, meta_ad_id: "1002", enrichment_attempts: 1 },
        { id: 3, meta_ad_id: "1003", enrichment_attempts: 1 },
      ];
    },
    async markMetaEnrichmentSuccess() {
      throw new Error("should not succeed");
    },
    async markMetaEnrichmentDeferred(id, message, delayMs) {
      deferred.push({ id, message, delayMs });
      return { id };
    },
  };
  const api = {
    configured: () => true,
    async fetchAdDetails(adId) {
      fetched.push(adId);
      const err = new Error("Missing ads_read permission");
      err.code = 10;
      err.configurationError = true;
      err.retryable = false;
      throw err;
    },
  };

  const service = createMetaAdsEnrichmentService({
    repo,
    api,
    events: { publish() {} },
    logger: silentLogger(),
  });
  const result = await service.runSweep();

  assert.equal(result.status, "completed");
  assert.deepEqual(fetched, ["1001"]);
  assert.equal(deferred.length, 3);
  assert.equal(deferred[0].delayMs, CONFIGURATION_ERROR_DELAY_MS);
  assert.equal(deferred[1].delayMs, CONFIGURATION_ERROR_DELAY_MS);
  assert.equal(deferred[2].delayMs, CONFIGURATION_ERROR_DELAY_MS);
});

test("worker stays dormant when Marketing API is not configured", async () => {
  let claims = 0;
  const repo = {
    async claimMetaEnrichmentBatch() {
      claims += 1;
      return [];
    },
  };
  const api = { configured: () => false };
  const service = createMetaAdsEnrichmentService({
    repo,
    api,
    events: { publish() {} },
    logger: silentLogger(),
  });

  assert.deepEqual(await service.runSweep(), { status: "not_configured", processed: 0 });
  assert.equal(service.queueAttributionEnrichment(99), false);
  assert.equal(claims, 0);
});

test("retry backoff grows but eventually caps at one day", () => {
  assert.equal(retryDelayMs(1, { retryable: true }), 60 * 1000);
  assert.equal(retryDelayMs(2, { retryable: true }), 5 * 60 * 1000);
  assert.equal(retryDelayMs(5, { retryable: true }), 6 * 60 * 60 * 1000);
  assert.equal(retryDelayMs(99, { retryable: true }), 24 * 60 * 60 * 1000);
  assert.equal(
    retryDelayMs(1, { configurationError: true, retryable: false }),
    CONFIGURATION_ERROR_DELAY_MS
  );
});
