const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AD_FIELDS,
  MetaAdsApiError,
  buildAdDetailsUrl,
  fetchAdDetails,
  isConfigurationGraphFailure,
  isRetryableGraphFailure,
} = require("../src/services/metaAdsApiService");

test("builds a read-only ad details request for the configured Graph version", () => {
  const url = new URL(buildAdDetailsUrl("120210000001234", "v26.0"));
  assert.equal(url.origin, "https://graph.facebook.com");
  assert.equal(url.pathname, "/v26.0/120210000001234");
  assert.equal(url.searchParams.get("fields"), AD_FIELDS);
  assert.equal(url.searchParams.has("access_token"), false);
});

test("normalizes Ad, Ad Set, Campaign and account details from Meta", async () => {
  let requestedUrl = null;
  let requestedOptions = null;
  const fetchImpl = async (url, options) => {
    requestedUrl = url;
    requestedOptions = options;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          id: "120210000001234",
          name: "HIFU Doctor Video V3",
          account_id: "123456789",
          adset: { id: "120210000001111", name: "Women 25-45 KL" },
          campaign: { id: "120210000001000", name: "HIFU September Sales" },
        });
      },
    };
  };

  const details = await fetchAdDetails("120210000001234", {
    fetchImpl,
    token: "secret-marketing-token",
    version: "v26.0",
    timeoutMs: 5000,
  });

  assert.deepEqual(details, {
    adId: "120210000001234",
    adName: "HIFU Doctor Video V3",
    accountId: "123456789",
    adsetId: "120210000001111",
    adsetName: "Women 25-45 KL",
    campaignId: "120210000001000",
    campaignName: "HIFU September Sales",
  });
  assert.match(requestedUrl, /graph\.facebook\.com\/v26\.0\/120210000001234/);
  assert.equal(requestedUrl.includes("secret-marketing-token"), false);
  assert.equal(requestedOptions.headers.Authorization, "Bearer secret-marketing-token");
});

test("classifies token and permission failures as configuration-wide errors", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    async text() {
      return JSON.stringify({ error: { code: 190, message: "Invalid OAuth access token." } });
    },
  });

  await assert.rejects(
    fetchAdDetails("120210000001234", {
      fetchImpl,
      token: "bad-token",
      version: "v26.0",
      timeoutMs: 5000,
    }),
    (err) => {
      assert.ok(err instanceof MetaAdsApiError);
      assert.equal(err.code, 190);
      assert.equal(err.configurationError, true);
      assert.equal(err.retryable, false);
      return true;
    }
  );

  assert.equal(isConfigurationGraphFailure(10), true);
  assert.equal(isConfigurationGraphFailure(190), true);
  assert.equal(isConfigurationGraphFailure(200), true);
  assert.equal(isConfigurationGraphFailure(4), false);
});

test("classifies rate limits and Meta transient failures as retryable", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    async text() {
      return JSON.stringify({ error: { code: 4, message: "Application request limit reached." } });
    },
  });

  await assert.rejects(
    fetchAdDetails("120210000001234", {
      fetchImpl,
      token: "token",
      version: "v26.0",
      timeoutMs: 5000,
    }),
    (err) => err instanceof MetaAdsApiError && err.retryable === true
  );

  assert.equal(isRetryableGraphFailure(500, null), true);
  assert.equal(isRetryableGraphFailure(429, 4), true);
  assert.equal(isRetryableGraphFailure(400, 190), false);
});

test("rejects malformed ad IDs before making a network request", async () => {
  let called = false;
  await assert.rejects(
    fetchAdDetails("not-an-ad-id", {
      fetchImpl: async () => {
        called = true;
        throw new Error("should not run");
      },
      token: "token",
    }),
    /Meta ad ID is missing or invalid/
  );
  assert.equal(called, false);
});
