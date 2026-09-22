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

test("routes a batched Meta webhook as isolated, newly signed client payloads", async () => {
  const body = {
    object: "page",
    entry: [
      { id: "page-a", messaging: [{ message: { mid: "a" } }] },
      { id: "page-b", messaging: [{ message: { mid: "b" } }] },
    ],
  };
  const appSecret = "meta-secret";
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
    appSecret,
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

  const byUrl = new Map(requests.map((request) => [request.url, request]));
  const clientA = byUrl.get("https://client-a.example.test/meta-webhook");
  const clientB = byUrl.get("https://client-b.example.test/meta-webhook");
  assert.deepEqual(JSON.parse(Buffer.from(clientA.options.body).toString("utf8")).entry, [body.entry[0]]);
  assert.deepEqual(JSON.parse(Buffer.from(clientB.options.body).toString("utf8")).entry, [body.entry[1]]);

  for (const request of requests) {
    const raw = Buffer.from(request.options.body);
    assert.equal(
      request.options.headers["X-Hub-Signature-256"],
      expectedMetaSignature(appSecret, raw),
    );
    assert.equal(request.options.headers["X-DA-Meta-Router"], "1");
  }
});

test("forwards once with all matching entries when several assets resolve to the same client target", async () => {
  const body = { object: "page", entry: [{ id: "page-a" }, { id: "page-a-2" }] };
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
    appSecret: "meta-secret",
    repo,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
  });

  assert.equal(requests.length, 1);
  const forwardedBody = JSON.parse(Buffer.from(requests[0].options.body).toString("utf8"));
  assert.deepEqual(forwardedBody.entry.map((entry) => entry.id), ["page-a", "page-a-2"]);
});

test("fails closed when any asset in the webhook has no registered route", async () => {
  const body = { object: "instagram", entry: [{ id: "ig-a" }, { id: "ig-missing" }] };
  await assert.rejects(
    routeRawWebhook({
      body,
      appSecret: "meta-secret",
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
      appSecret: "meta-secret",
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

test("refuses to route isolated payloads without the shared Meta app secret", async () => {
  const body = { object: "page", entry: [{ id: "page-a" }] };
  await assert.rejects(
    routeRawWebhook({
      body,
      repo: { getRoutes: async () => [] },
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    (err) => err.code === "META_ROUTE_SECRET_MISSING",
  );
});
