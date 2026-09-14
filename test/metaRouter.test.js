const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectAssetIds,
  expectedMetaSignature,
  routeRawWebhook,
  verifyMetaSignature,
} = require("../src/metaRouter/server");

test("verifies Meta webhook signatures against the exact raw body", () => {
  const rawBody = Buffer.from(JSON.stringify({ object: "page", entry: [] }));
  const signature = expectedMetaSignature("meta-secret", rawBody);

  assert.equal(verifyMetaSignature("meta-secret", signature, rawBody), true);
  assert.throws(
    () => verifyMetaSignature("meta-secret", signature, Buffer.from("{}")),
    (err) => err.code === "META_SIGNATURE_MISMATCH",
  );
});

test("collects unique business asset ids from one Meta webhook", () => {
  assert.deepEqual(
    collectAssetIds({ entry: [{ id: "page-a" }, { id: "page-b" }, { id: "page-a" }] }),
    ["page-a", "page-b"],
  );
});

test("routes one signed batch to each affected client without rewriting the body", async () => {
  const body = {
    object: "page",
    entry: [
      { id: "page-a", messaging: [{ message: { mid: "a" } }] },
      { id: "page-b", messaging: [{ message: { mid: "b" } }] },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = expectedMetaSignature("meta-secret", rawBody);
  const routes = new Map([
    ["page-a", {
      clientSlug: "client-a",
      channel: "facebook",
      assetId: "page-a",
      targetBaseUrl: "https://client-a.example.test",
      enabled: true,
    }],
    ["page-b", {
      clientSlug: "client-b",
      channel: "facebook",
      assetId: "page-b",
      targetBaseUrl: "https://client-b.example.test",
      enabled: true,
    }],
  ]);
  const repo = {
    async getRoutes(channel, assetIds) {
      assert.equal(channel, "facebook");
      return assetIds.map((id) => routes.get(id)).filter(Boolean);
    },
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200 };
  };

  const result = await routeRawWebhook({
    body,
    rawBody,
    signature,
    repo,
    fetchImpl,
  });

  assert.equal(result.ignored, false);
  assert.equal(result.channel, "facebook");
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((item) => item.url).sort(),
    [
      "https://client-a.example.test/meta-webhook",
      "https://client-b.example.test/meta-webhook",
    ],
  );
  for (const request of requests) {
    assert.equal(request.options.headers["X-Hub-Signature-256"], signature);
    assert.equal(request.options.headers["X-DA-Meta-Router"], "1");
    assert.deepEqual(Buffer.from(request.options.body), rawBody);
  }
});

test("forwards only once when several assets resolve to the same client target", async () => {
  const body = { object: "page", entry: [{ id: "page-a" }, { id: "page-a-2" }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const requests = [];
  const repo = {
    async getRoutes() {
      return [
        {
          clientSlug: "client-a",
          channel: "facebook",
          assetId: "page-a",
          targetBaseUrl: "https://client-a.example.test",
          enabled: true,
        },
        {
          clientSlug: "client-a",
          channel: "facebook",
          assetId: "page-a-2",
          targetBaseUrl: "https://client-a.example.test",
          enabled: true,
        },
      ];
    },
  };

  await routeRawWebhook({
    body,
    rawBody,
    signature: "sha256=test",
    repo,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.equal(requests.length, 1);
});

test("fails closed when any asset in the webhook has no registered route", async () => {
  const body = { object: "instagram", entry: [{ id: "ig-a" }, { id: "ig-missing" }] };
  await assert.rejects(
    routeRawWebhook({
      body,
      rawBody: Buffer.from(JSON.stringify(body)),
      signature: "sha256=test",
      repo: {
        async getRoutes() {
          return [{
            clientSlug: "client-a",
            channel: "instagram",
            assetId: "ig-a",
            targetBaseUrl: "https://client-a.example.test",
            enabled: true,
          }];
        },
      },
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    (err) => err.code === "META_ROUTE_NOT_FOUND"
      && Array.isArray(err.assetIds)
      && err.assetIds.includes("ig-missing"),
  );
});

test("fails closed when a registered route is disabled", async () => {
  const body = { object: "page", entry: [{ id: "page-a" }] };
  await assert.rejects(
    routeRawWebhook({
      body,
      rawBody: Buffer.from(JSON.stringify(body)),
      signature: "sha256=test",
      repo: {
        async getRoutes() {
          return [{
            clientSlug: "client-a",
            channel: "facebook",
            assetId: "page-a",
            targetBaseUrl: "https://client-a.example.test",
            enabled: false,
          }];
        },
      },
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    (err) => err.code === "META_ROUTE_DISABLED",
  );
});
