const test = require("node:test");
const assert = require("node:assert/strict");

const {
  INSIGHT_FIELDS,
  buildInsightsUrl,
  fetchAdInsights,
  safePagingUrl,
} = require("../src/services/metaAdsInsightsApiService");

test("builds daily ad-level Insights requests without putting the token in the URL", () => {
  const url = new URL(buildInsightsUrl("act_123456789", {
    since: "2026-09-01",
    until: "2026-09-30",
    version: "v26.0",
  }));

  assert.equal(url.origin, "https://graph.facebook.com");
  assert.equal(url.pathname, "/v26.0/act_123456789/insights");
  assert.equal(url.searchParams.get("level"), "ad");
  assert.equal(url.searchParams.get("time_increment"), "1");
  assert.equal(url.searchParams.get("fields"), INSIGHT_FIELDS);
  assert.deepEqual(JSON.parse(url.searchParams.get("time_range")), {
    since: "2026-09-01",
    until: "2026-09-30",
  });
  assert.equal(url.searchParams.has("access_token"), false);
});

test("normalizes Insights rows and follows Meta pagination using the auth header", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: [{
              date_start: "2026-10-01",
              date_stop: "2026-10-01",
              account_id: "123456789",
              campaign_id: "100",
              campaign_name: "October Pelvis",
              adset_id: "200",
              adset_name: "Women 25-44",
              ad_id: "300",
              ad_name: "Video A",
              spend: "15.50",
              impressions: "1000",
              reach: "800",
              clicks: "25",
              ctr: "2.5",
              cpc: "0.62",
              cpm: "15.5",
              frequency: "1.25",
              actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "4" }],
            }],
            paging: {
              next: "https://graph.facebook.com/v26.0/act_123456789/insights?after=cursor&access_token=should-not-be-reused",
            },
          });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: [{
            date_start: "2026-10-02",
            account_id: "123456789",
            campaign_id: "100",
            adset_id: "200",
            ad_id: "300",
            spend: "10",
            impressions: "500",
            reach: "400",
            clicks: "10",
          }],
        });
      },
    };
  };

  const rows = await fetchAdInsights("123456789", {
    since: "2026-10-01",
    until: "2026-10-02",
    fetchImpl,
    token: "secret-token",
    version: "v26.0",
    timeoutMs: 5000,
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    accountId: "123456789",
    date: "2026-10-01",
    campaignId: "100",
    campaignName: "October Pelvis",
    adsetId: "200",
    adsetName: "Women 25-44",
    adId: "300",
    adName: "Video A",
    spend: 15.5,
    impressions: 1000,
    reach: 800,
    clicks: 25,
    ctr: 2.5,
    cpc: 0.62,
    cpm: 15.5,
    frequency: 1.25,
    actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "4" }],
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(requests[1].options.headers.Authorization, "Bearer secret-token");
  assert.equal(new URL(requests[1].url).searchParams.has("access_token"), false);
});

test("rejects unexpected pagination hosts", () => {
  assert.throws(
    () => safePagingUrl("https://example.com/steal-token"),
    /unexpected paging host/
  );
});
