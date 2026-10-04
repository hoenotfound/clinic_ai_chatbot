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

test("batch enrichment reuses hierarchy already stored by Insights sync", async () => {
  let apiFetches = 0;
  let hierarchyLookups = 0;
  const successes = [];
  const repo = {
    async claimMetaEnrichmentBatch() {
      return [
        { id: 1, lead_id: 101, meta_ad_id: "120210000001234", enrichment_attempts: 1 },
        { id: 2, lead_id: 102, meta_ad_id: "120210000001234", enrichment_attempts: 1 },
      ];
    },
    async markMetaEnrichmentSuccess(id, details) {
      successes.push([id, details]);
      return { id, lead_id: id + 100, enrichment_status: "enriched" };
    },
    async markMetaEnrichmentDeferred() {
      throw new Error("should not defer");
    },
  };
  const hierarchyRepo = {
    async getLatestHierarchyForAdIds(adIds) {
      hierarchyLookups += 1;
      assert.deepEqual(adIds, ["120210000001234"]);
      return new Map([[
        "120210000001234",
        {
          ad_id: "120210000001234",
          ad_name: "Pelvis Creative",
          account_id: "289145050863605",
          adset_id: "120210000000002",
          adset_name: "Women KL",
          campaign_id: "120210000000001",
          campaign_name: "Pelvis Campaign",
        },
      ]]);
    },
  };
  const api = {
    configured: () => true,
    async fetchAdDetails() {
      apiFetches += 1;
      throw new Error("Meta API should not be called when cached hierarchy is complete");
    },
  };

  const service = createMetaAdsEnrichmentService({
    repo,
    api,
    hierarchyRepo,
    events: { publish() {} },
    logger: silentLogger(),
  });
  const result = await service.runSweep();

  assert.equal(result.processed, 2);
  assert.equal(hierarchyLookups, 1);
  assert.equal(apiFetches, 0);
  assert.equal(successes.length, 2);
  assert.equal(successes[0][1].campaignName, "Pelvis Campaign");
});

test("duplicate ads in one enrichment batch call Meta only once on a cache miss", async () => {
  let apiFetches = 0;
  const repo = {
    async claimMetaEnrichmentBatch() {
      return [
        { id: 1, lead_id: 101, meta_ad_id: "120210000009999", enrichment_attempts: 1 },
        { id: 2, lead_id: 102, meta_ad_id: "120210000009999", enrichment_attempts: 1 },
        { id: 3, lead_id: 103, meta_ad_id: "120210000009999", enrichment_attempts: 1 },
      ];
    },
    async markMetaEnrichmentSuccess(id) {
      return { id, lead_id: id + 100, enrichment_status: "enriched" };
    },
    async markMetaEnrichmentDeferred() {
      throw new Error("should not defer");
    },
  };
  const hierarchyRepo = {
    async getLatestHierarchyForAdIds() {
      return new Map();
    },
  };
  const api = {
    configured: () => true,
    async fetchAdDetails(adId) {
      apiFetches += 1;
      return {
        adId,
        adName: "Fresh Creative",
        accountId: "289145050863605",
        adsetId: "120210000000012",
        adsetName: "Fresh Ad Set",
        campaignId: "120210000000011",
        campaignName: "Fresh Campaign",
      };
    },
  };

  const service = createMetaAdsEnrichmentService({
    repo,
    api,
    hierarchyRepo,
    events: { publish() {} },
    logger: silentLogger(),
  });
  const result = await service.runSweep();

  assert.equal(result.processed, 3);
  assert.equal(apiFetches, 1);
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

test("rapid enrichment triggers coalesce into one durable batch sweep", async () => {
  const immediates = [];
  let claims = 0;
  const repo = {
    async claimMetaEnrichmentBatch() {
      claims += 1;
      return [];
    },
  };
  const api = { configured: () => true };
  const service = createMetaAdsEnrichmentService({
    repo,
    api,
    events: { publish() {} },
    logger: silentLogger(),
    setImmediateImpl(callback) {
      immediates.push(callback);
      return { unref() {} };
    },
  });

  assert.equal(service.queueAttributionEnrichment(1), true);
  assert.equal(service.queueAttributionEnrichment(2), true);
  assert.equal(service.queueAttributionEnrichment(3), true);
  assert.equal(immediates.length, 1);

  await immediates[0]();
  assert.equal(claims, 1);
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
