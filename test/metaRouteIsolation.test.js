const test = require("node:test");
const assert = require("node:assert/strict");

const {
  configuredWebhookAssetId,
  filterBodyForConfiguredAsset,
  installMetaRouteIsolation,
  webhookChannel,
} = require("../src/services/metaRouteIsolationBootstrap");

test("identifies Messenger and Instagram webhook objects", () => {
  assert.equal(webhookChannel({ object: "page" }), "facebook");
  assert.equal(webhookChannel({ object: "instagram" }), "instagram");
  assert.equal(webhookChannel({ object: "whatsapp_business_account" }), null);
});

test("uses the Page ID as the Messenger routing identity", () => {
  assert.equal(
    configuredWebhookAssetId("facebook", { FACEBOOK_PAGE_ID: "page-a" }),
    "page-a",
  );
});

test("uses a separate Instagram Professional Account ID for webhook routing", () => {
  assert.equal(
    configuredWebhookAssetId("instagram", {
      INSTAGRAM_PAGE_ID: "linked-page-a",
      INSTAGRAM_ACCOUNT_ID: "ig-business-a",
    }),
    "ig-business-a",
  );
});

test("filters a multi-client Messenger batch to the configured Page", () => {
  const body = {
    object: "page",
    entry: [
      { id: "page-a", messaging: [{ message: { mid: "a" } }] },
      { id: "page-b", messaging: [{ message: { mid: "b" } }] },
    ],
  };

  assert.deepEqual(
    filterBodyForConfiguredAsset(body, { FACEBOOK_PAGE_ID: "page-b" }),
    {
      object: "page",
      entry: [{ id: "page-b", messaging: [{ message: { mid: "b" } }] }],
    },
  );
});

test("filters a multi-client Instagram batch to the configured Instagram account", () => {
  const body = {
    object: "instagram",
    entry: [
      { id: "ig-business-a", messaging: [{ message: { mid: "a" } }] },
      { id: "ig-business-b", messaging: [{ message: { mid: "b" } }] },
    ],
  };

  assert.deepEqual(
    filterBodyForConfiguredAsset(body, { INSTAGRAM_ACCOUNT_ID: "ig-business-a" }),
    {
      object: "instagram",
      entry: [{ id: "ig-business-a", messaging: [{ message: { mid: "a" } }] }],
    },
  );
});

test("keeps legacy single-client Instagram behavior until routing identity is configured", () => {
  const body = {
    object: "instagram",
    entry: [{ id: "ig-business-a" }, { id: "ig-business-b" }],
  };
  assert.equal(filterBodyForConfiguredAsset(body, {}), body);
});

test("isolation wraps both normal messages and message-edit resolution", async () => {
  const seen = [];
  const service = {
    parseIncomingMessages(body) {
      seen.push(["parse", body]);
      return body.entry;
    },
    async resolveMessageEditEvents(body) {
      seen.push(["resolve", body]);
      return body.entry;
    },
  };
  installMetaRouteIsolation({
    service,
    env: { FACEBOOK_PAGE_ID: "page-a" },
  });

  const body = {
    object: "page",
    entry: [{ id: "page-a" }, { id: "page-b" }],
  };
  const parsed = service.parseIncomingMessages(body);
  const resolved = await service.resolveMessageEditEvents(body);

  assert.deepEqual(parsed, [{ id: "page-a" }]);
  assert.deepEqual(resolved, [{ id: "page-a" }]);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0][1].entry, [{ id: "page-a" }]);
  assert.deepEqual(seen[1][1].entry, [{ id: "page-a" }]);
});
