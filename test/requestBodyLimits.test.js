const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");

const { verifyWebhookSignature } = require("../src/middleware/verifyWebhookSignature");
const { verifyMetaWebhookSignature } = require("../src/middleware/verifyMetaWebhookSignature");
const {
  ADVANCED_CONFIG_JSON_LIMIT,
  PORTAL_JSON_LIMIT,
  WEBHOOK_JSON_LIMIT,
  createAdvancedConfigJsonParser,
  createPortalJsonParser,
  createWebhookJsonParser,
  payloadTooLargeErrorHandler,
} = require("../src/middleware/requestBodyLimits");
const {
  createMetaRouterApp,
  expectedMetaSignature,
} = require("../src/metaRouter/server");

function hmac(secret, rawBody) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

async function withServer(app, run) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });
  const address = server.address();
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postRaw(url, path, rawBody, headers = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: rawBody,
  });
}

function whatsappBatchPayload() {
  const statuses = Array.from({ length: 900 }, (_, index) => ({
    id: `wamid.${index}.${"x".repeat(120)}`,
    status: "delivered",
    timestamp: "1790590000",
    recipient_id: "60123456789",
  }));
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-test",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "60123456789", phone_number_id: "10001" },
          statuses,
        },
      }],
    }],
  };
}

function socialBatchPayload() {
  const messaging = Array.from({ length: 700 }, (_, index) => ({
    sender: { id: `psid-${index}` },
    recipient: { id: "page-1" },
    timestamp: 1790590000000 + index,
    message: {
      mid: `mid-${index}-${"y".repeat(120)}`,
      text: "Normal batched message",
    },
  }));
  return {
    object: "page",
    entry: [{ id: "page-1", time: 1790590000000, messaging }],
  };
}

function oversizedJson(bytes) {
  return JSON.stringify({ payload: "z".repeat(bytes) });
}

test("request body limits are explicit and keep Advanced Config isolated from normal portal JSON", () => {
  assert.equal(WEBHOOK_JSON_LIMIT, "2mb");
  assert.equal(PORTAL_JSON_LIMIT, "100kb");
  assert.equal(ADVANCED_CONFIG_JSON_LIMIT, "512kb");
});

test("signed WhatsApp webhook batch above 100 KB is accepted below the 2 MB webhook limit", async (t) => {
  const oldSecret = process.env.WHATSAPP_APP_SECRET;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = oldSecret;
  });
  process.env.WHATSAPP_APP_SECRET = "whatsapp-test-secret";

  const app = express();
  app.post(
    "/webhook",
    createWebhookJsonParser(verifyWebhookSignature),
    (req, res) => res.json({ ok: true, statuses: req.body.entry[0].changes[0].value.statuses.length }),
  );
  app.use(payloadTooLargeErrorHandler);

  const rawBody = JSON.stringify(whatsappBatchPayload());
  assert.ok(Buffer.byteLength(rawBody) > 100 * 1024);
  assert.ok(Buffer.byteLength(rawBody) < 2 * 1024 * 1024);

  await withServer(app, async (url) => {
    const response = await postRaw(url, "/webhook", rawBody, {
      "X-Hub-Signature-256": hmac(process.env.WHATSAPP_APP_SECRET, rawBody),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, statuses: 900 });
  });
});

test("signed Facebook/Instagram webhook batch above 100 KB is accepted below the 2 MB limit", async (t) => {
  const oldSecret = process.env.META_APP_SECRET;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = oldSecret;
  });
  process.env.META_APP_SECRET = "meta-test-secret";

  const app = express();
  app.post(
    "/meta-webhook",
    createWebhookJsonParser(verifyMetaWebhookSignature),
    (req, res) => res.json({ ok: true, messages: req.body.entry[0].messaging.length }),
  );
  app.use(payloadTooLargeErrorHandler);

  const rawBody = JSON.stringify(socialBatchPayload());
  assert.ok(Buffer.byteLength(rawBody) > 100 * 1024);
  assert.ok(Buffer.byteLength(rawBody) < 2 * 1024 * 1024);

  await withServer(app, async (url) => {
    const response = await postRaw(url, "/meta-webhook", rawBody, {
      "X-Hub-Signature-256": hmac(process.env.META_APP_SECRET, rawBody),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, messages: 700 });
  });
});

test("WhatsApp webhook rejects payloads above 2 MB with a clean 413 response", async (t) => {
  const oldSecret = process.env.WHATSAPP_APP_SECRET;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = oldSecret;
  });
  process.env.WHATSAPP_APP_SECRET = "whatsapp-test-secret";

  const app = express();
  app.post(
    "/webhook",
    createWebhookJsonParser(verifyWebhookSignature),
    (_req, res) => res.sendStatus(200),
  );
  app.use(payloadTooLargeErrorHandler);

  const rawBody = oversizedJson(2 * 1024 * 1024 + 1024);

  await withServer(app, async (url) => {
    const response = await postRaw(url, "/webhook", rawBody, {
      "X-Hub-Signature-256": hmac(process.env.WHATSAPP_APP_SECRET, rawBody),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: "Request body is too large.",
      code: "payload_too_large",
    });
  });
});

test("social webhook rejects payloads above 2 MB with a clean 413 response", async (t) => {
  const oldSecret = process.env.META_APP_SECRET;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = oldSecret;
  });
  process.env.META_APP_SECRET = "meta-test-secret";

  const app = express();
  app.post(
    "/meta-webhook",
    createWebhookJsonParser(verifyMetaWebhookSignature),
    (_req, res) => res.sendStatus(200),
  );
  app.use(payloadTooLargeErrorHandler);

  const rawBody = oversizedJson(2 * 1024 * 1024 + 1024);

  await withServer(app, async (url) => {
    const response = await postRaw(url, "/meta-webhook", rawBody, {
      "X-Hub-Signature-256": hmac(process.env.META_APP_SECRET, rawBody),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "payload_too_large");
  });
});

test("portal API JSON remains capped at the existing 100 KB behavior", async () => {
  const app = express();
  app.use("/api", createPortalJsonParser());
  app.post("/api/test", (req, res) => res.json({ ok: true, value: req.body.value }));
  app.use(payloadTooLargeErrorHandler);

  await withServer(app, async (url) => {
    const small = await postRaw(url, "/api/test", JSON.stringify({ value: "ok" }));
    assert.equal(small.status, 200);
    assert.deepEqual(await small.json(), { ok: true, value: "ok" });

    const large = await postRaw(url, "/api/test", oversizedJson(101 * 1024));
    assert.equal(large.status, 413);
    assert.equal((await large.json()).code, "payload_too_large");
  });
});

test("Advanced Config accepts larger JSON while normal portal routes keep the 100 KB cap", async () => {
  const app = express();
  const portalParser = createPortalJsonParser();
  const advancedParser = createAdvancedConfigJsonParser();

  app.use("/api", (req, res, next) => {
    const parser = req.path === "/advanced-config" || req.path.startsWith("/advanced-config/")
      ? advancedParser
      : portalParser;
    return parser(req, res, next);
  });
  app.post("/api/test", (req, res) => res.json({ ok: true, size: req.body.payload.length }));
  app.post("/api/advanced-config/preview", (req, res) => res.json({ ok: true, size: req.body.payload.length }));
  app.use(payloadTooLargeErrorHandler);

  await withServer(app, async (url) => {
    const mediumBody = oversizedJson(200 * 1024);

    const normal = await postRaw(url, "/api/test", mediumBody);
    assert.equal(normal.status, 413);
    assert.equal((await normal.json()).code, "payload_too_large");

    const advanced = await postRaw(url, "/api/advanced-config/preview", mediumBody);
    assert.equal(advanced.status, 200);
    assert.equal((await advanced.json()).ok, true);

    const tooLarge = await postRaw(
      url,
      "/api/advanced-config/preview",
      oversizedJson(513 * 1024)
    );
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, "payload_too_large");
  });
});

test("signature verification still rejects a wrong signature below the size limit", async (t) => {
  const oldSecret = process.env.WHATSAPP_APP_SECRET;
  t.after(() => {
    if (oldSecret === undefined) delete process.env.WHATSAPP_APP_SECRET;
    else process.env.WHATSAPP_APP_SECRET = oldSecret;
  });
  process.env.WHATSAPP_APP_SECRET = "whatsapp-test-secret";

  const app = express();
  app.post(
    "/webhook",
    createWebhookJsonParser(verifyWebhookSignature),
    (_req, res) => res.sendStatus(200),
  );
  app.use(payloadTooLargeErrorHandler);

  const rawBody = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  await withServer(app, async (url) => {
    const response = await postRaw(url, "/webhook", rawBody, {
      "X-Hub-Signature-256": hmac("wrong-secret", rawBody),
    });
    assert.equal(response.status, 403);
  });
});

test("central Meta router uses the shared 2 MB limit and returns clean 413 JSON", async () => {
  const appSecret = "meta-router-secret";
  const app = createMetaRouterApp({
    env: {
      META_APP_SECRET: appSecret,
      META_VERIFY_TOKEN: "verify-token",
    },
    repo: {
      async getRoutes() {
        return [];
      },
    },
  });

  const smallRaw = JSON.stringify({ object: "page", entry: [] });
  const largeRaw = oversizedJson(2 * 1024 * 1024 + 1024);

  await withServer(app, async (url) => {
    const small = await postRaw(url, "/meta-webhook", smallRaw, {
      "X-Hub-Signature-256": expectedMetaSignature(appSecret, Buffer.from(smallRaw)),
    });
    assert.equal(small.status, 200);

    const large = await postRaw(url, "/meta-webhook", largeRaw, {
      "X-Hub-Signature-256": expectedMetaSignature(appSecret, Buffer.from(largeRaw)),
    });
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), {
      error: "Request body is too large.",
      code: "payload_too_large",
    });
  });
});
