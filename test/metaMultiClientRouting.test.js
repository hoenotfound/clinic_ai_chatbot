const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  expectedMetaSignature,
  routeRawWebhook,
  verifyMetaSignature,
} = require("../src/metaRouter/server");
const {
  filterBodyForConfiguredAsset,
} = require("../src/services/metaRouteIsolationBootstrap");

test("Meta router verifies the exact raw payload signature", () => {
  const secret = "shared-meta-app-secret";
  const rawBody = Buffer.from('{"object":"page","entry":[{"id":"page-a"}]}');
  const signature = expectedMetaSignature(secret, rawBody);

  assert.doesNotThrow(() => verifyMetaSignature(secret, signature, rawBody));
  assert.throws(
    () => verifyMetaSignature(secret, `sha256=${crypto.createHash("sha256").update(rawBody).digest("hex")}`, rawBody),
    /signature mismatch/i,
  );
});

test("Meta router forwards original signed bytes to each affected client", async () => {
  const body = {
    object: "page",
    entry: [
      { id: "page-a", messaging: [{ sender: { id: "user-a" }, message: { mid: "a1", text: "A" } }] },
      { id: "page-b", messaging: [{ sender: { id: "user-b" }, message: { mid: "b1", text: "B" } }] },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = "sha256=provider-signature";
  const routes = new Map([
    ["page-a", { clientSlug: "client-a", channel: "facebook", assetId: "page-a", targetBaseUrl: "https://client-a.example.test", enabled: true }],
    ["page-b", { clientSlug: "client-b", channel: "facebook", assetId: "page-b", targetBaseUrl: "https://client-b.example.test", enabled: true }],
  ]);
  const repo = {
    async getRoutes(channel, ids) {
      assert.equal(channel, "facebook");
      return ids.map((id) => routes.get(id)).filter(Boolean);
    },
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };

  const result = await routeRawWebhook({ body, rawBody, signature, repo, fetchImpl });

  assert.equal(result.channel, "facebook");
  assert.equal(result.forwarded.length, 2);
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      "https://client-a.example.test/meta-webhook",
      "https://client-b.example.test/meta-webhook",
    ],
  );
  for (const call of calls) {
    assert.equal(call.options.headers["X-Hub-Signature-256"], signature);
    assert.equal(Buffer.compare(call.options.body, rawBody), 0);
  }
});

test("Meta router fails closed when an asset has no registered route", async () => {
  const body = {
    object: "instagram",
    entry: [{ id: "ig-missing", messaging: [] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const repo = { getRoutes: async () => [] };

  await assert.rejects(
    routeRawWebhook({
      body,
      rawBody,
      signature: "sha256=signature",
      repo,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    (err) => err.code === "META_ROUTE_NOT_FOUND",
  );
});

test("client runtime filters routed Facebook entries to its own Page", () => {
  const body = {
    object: "page",
    entry: [
      { id: "page-a", messaging: [{ message: { mid: "a" } }] },
      { id: "page-b", messaging: [{ message: { mid: "b" } }] },
    ],
  };
  const filtered = filterBodyForConfiguredAsset(body, {
    FACEBOOK_PAGE_ID: "page-b",
  });

  assert.deepEqual(filtered.entry.map((entry) => entry.id), ["page-b"]);
  assert.equal(body.entry.length, 2, "filtering must not mutate Meta's original parsed body");
});

test("client runtime uses Instagram Professional Account ID for route isolation", () => {
  const body = {
    object: "instagram",
    entry: [
      { id: "ig-a", messaging: [] },
      { id: "ig-b", messaging: [] },
    ],
  };
  const filtered = filterBodyForConfiguredAsset(body, {
    INSTAGRAM_ACCOUNT_ID: "ig-a",
    INSTAGRAM_PAGE_ID: "linked-page-id",
  });

  assert.deepEqual(filtered.entry.map((entry) => entry.id), ["ig-a"]);
});

test("legacy Instagram deployment without routing ID keeps existing behavior", () => {
  const body = {
    object: "instagram",
    entry: [{ id: "ig-a" }, { id: "ig-b" }],
  };
  assert.equal(filterBodyForConfiguredAsset(body, { INSTAGRAM_PAGE_ID: "linked-page" }), body);
});
