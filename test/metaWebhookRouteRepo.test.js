const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMetaWebhookRouteRepo,
  normalizeAssetId,
  normalizeChannel,
  normalizeClientSlug,
  normalizeTargetBaseUrl,
  rowToRoute,
} = require("../src/metaRouter/routeRepo");

test("normalizes supported Meta routing channels", () => {
  assert.equal(normalizeChannel(" Facebook "), "facebook");
  assert.equal(normalizeChannel("INSTAGRAM"), "instagram");
  assert.throws(() => normalizeChannel("whatsapp"), /Unsupported Meta webhook route channel/);
});

test("requires a stable normalized client slug", () => {
  assert.equal(normalizeClientSlug("beleco-clinic"), "beleco-clinic");
  assert.throws(() => normalizeClientSlug("Beleco Clinic"), /normalized client slug/);
});

test("requires an asset id", () => {
  assert.equal(normalizeAssetId(" 12345 "), "12345");
  assert.throws(() => normalizeAssetId(""), /asset ID is required/);
});

test("accepts HTTPS targets, strips query fragments, and rejects embedded credentials", () => {
  assert.equal(
    normalizeTargetBaseUrl("https://client.example.test/?debug=1#part"),
    "https://client.example.test",
  );
  assert.throws(
    () => normalizeTargetBaseUrl("http://client.example.test"),
    /must use HTTPS/,
  );
  assert.throws(
    () => normalizeTargetBaseUrl("https://user:password@client.example.test"),
    /must not contain credentials/,
  );
});

test("maps database rows without exposing unrelated data", () => {
  assert.deepEqual(
    rowToRoute({
      client_slug: "beleco-clinic",
      channel: "facebook",
      asset_id: "page-1",
      target_base_url: "https://client.example.test",
      enabled: true,
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:01:00Z",
      secret_value: "must-not-leak",
    }),
    {
      clientSlug: "beleco-clinic",
      channel: "facebook",
      assetId: "page-1",
      targetBaseUrl: "https://client.example.test",
      enabled: true,
      createdAt: "2026-09-14T00:00:00Z",
      updatedAt: "2026-09-14T00:01:00Z",
    },
  );
});

test("upserts by channel and asset so one client can own several Pages", async () => {
  const queries = [];
  const queryable = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [{
          client_slug: params[0],
          channel: params[1],
          asset_id: params[2],
          target_base_url: params[3],
          enabled: params[4],
        }],
      };
    },
  };
  const repo = createMetaWebhookRouteRepo(queryable);

  await repo.upsertRoute({
    clientSlug: "client-a",
    channel: "facebook",
    assetId: "page-a",
    targetBaseUrl: "https://client-a.example.test",
  });
  await repo.upsertRoute({
    clientSlug: "client-a",
    channel: "facebook",
    assetId: "page-b",
    targetBaseUrl: "https://client-a.example.test",
  });

  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /ON CONFLICT \(channel, asset_id\)/i);
  assert.deepEqual(queries.map(({ params }) => params[2]), ["page-a", "page-b"]);
});
