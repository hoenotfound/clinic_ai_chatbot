const test = require("node:test");
const assert = require("node:assert/strict");

const {
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

test("accepts HTTPS targets and strips query fragments", () => {
  assert.equal(
    normalizeTargetBaseUrl("https://client.example.test/?debug=1#part"),
    "https://client.example.test",
  );
  assert.throws(
    () => normalizeTargetBaseUrl("http://client.example.test"),
    /must use HTTPS/,
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
