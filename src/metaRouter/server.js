require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { createOpsPool } = require("../ops/db");
const { runOpsMigrations } = require("../ops/migrationRunner");
const { createMetaWebhookRouteRepo } = require("./routeRepo");

const DEFAULT_PORT = 10002;
const DEFAULT_FORWARD_TIMEOUT_MS = 8000;
const MAX_FORWARD_TIMEOUT_MS = 30000;
const MAX_WEBHOOK_BYTES = "2mb";

function text(value) {
  return String(value || "").trim();
}

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function expectedMetaSignature(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function verifyMetaSignature(secret, signatureHeader, rawBody) {
  if (!text(secret)) throw new Error("META_APP_SECRET is required by the Meta webhook router.");
  if (!text(signatureHeader)) {
    const error = new Error("Missing X-Hub-Signature-256 header.");
    error.code = "META_SIGNATURE_MISSING";
    throw error;
  }
  const expected = expectedMetaSignature(secret, rawBody);
  if (!timingSafeTextEqual(signatureHeader, expected)) {
    const error = new Error("Meta webhook signature mismatch.");
    error.code = "META_SIGNATURE_MISMATCH";
    throw error;
  }
  return true;
}

function channelForObject(object) {
  if (object === "page") return "facebook";
  if (object === "instagram") return "instagram";
  return null;
}

function collectAssetIds(body) {
  return [...new Set(
    (Array.isArray(body?.entry) ? body.entry : [])
      .map((entry) => text(entry?.id))
      .filter(Boolean),
  )];
}

function routeFailure(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function targetWebhookUrl(baseUrl) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/meta-webhook`;
}

async function forwardRawWebhook({
  route,
  rawBody,
  signature,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_FORWARD_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = targetWebhookUrl(route.targetBaseUrl);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-DA-Meta-Router": "1",
      },
      body: rawBody,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw routeFailure(
        `Client ${route.clientSlug} rejected the routed Meta webhook with HTTP ${response.status}.`,
        "META_ROUTE_TARGET_REJECTED",
        { status: response.status, clientSlug: route.clientSlug },
      );
    }
    return {
      clientSlug: route.clientSlug,
      status: response.status,
      target: url,
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw routeFailure(
        `Client ${route.clientSlug} did not acknowledge the routed Meta webhook before timeout.`,
        "META_ROUTE_TARGET_TIMEOUT",
        { clientSlug: route.clientSlug },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function routeRawWebhook({
  body,
  rawBody,
  signature,
  repo,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_FORWARD_TIMEOUT_MS,
}) {
  const channel = channelForObject(body?.object);
  if (!channel) return { ignored: true, channel: null, forwarded: [] };

  const assetIds = collectAssetIds(body);
  if (!assetIds.length) return { ignored: true, channel, forwarded: [] };

  const routes = await repo.getRoutes(channel, assetIds);
  const routesByAsset = new Map(routes.map((route) => [route.assetId, route]));
  const missing = assetIds.filter((assetId) => !routesByAsset.has(assetId));
  if (missing.length) {
    throw routeFailure(
      `No ${channel} Meta webhook route is registered for asset(s): ${missing.join(", ")}.`,
      "META_ROUTE_NOT_FOUND",
      { channel, assetIds: missing },
    );
  }

  const disabled = routes.filter((route) => route.enabled !== true);
  if (disabled.length) {
    throw routeFailure(
      `Meta webhook route is disabled for client(s): ${disabled.map((route) => route.clientSlug).join(", ")}.`,
      "META_ROUTE_DISABLED",
      { channel },
    );
  }

  // Forward the exact original bytes, not a parsed/re-serialized payload. The
  // client deployment can therefore verify Meta's original X-Hub-Signature-256.
  // If Meta ever batches several businesses in one POST, each affected client
  // receives the original batch and its parser filters entries to its own asset.
  const distinctTargets = new Map();
  for (const assetId of assetIds) {
    const route = routesByAsset.get(assetId);
    const key = `${route.clientSlug}\n${route.targetBaseUrl}`;
    if (!distinctTargets.has(key)) distinctTargets.set(key, route);
  }

  const forwarded = await Promise.all(
    [...distinctTargets.values()].map((route) =>
      forwardRawWebhook({ route, rawBody, signature, fetchImpl, timeoutMs })
    ),
  );

  return { ignored: false, channel, forwarded };
}

function createMetaRouterApp({
  repo,
  env = process.env,
  fetchImpl = global.fetch,
  healthCheck = async () => true,
} = {}) {
  if (!repo) throw new Error("Meta webhook router requires a route repository.");
  const appSecret = text(env.META_APP_SECRET);
  const verifyToken = text(env.META_VERIFY_TOKEN);
  if (!appSecret) throw new Error("META_APP_SECRET is required by the Meta webhook router.");
  if (!verifyToken) throw new Error("META_VERIFY_TOKEN is required by the Meta webhook router.");

  const timeoutMs = boundedPositiveInteger(
    env.META_ROUTER_FORWARD_TIMEOUT_MS,
    DEFAULT_FORWARD_TIMEOUT_MS,
    { min: 1000, max: MAX_FORWARD_TIMEOUT_MS },
  );

  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", async (_req, res) => {
    try {
      await healthCheck();
      return res.json({ ok: true });
    } catch (_) {
      return res.status(503).json({ ok: false });
    }
  });

  app.get("/meta-webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && timingSafeTextEqual(token, verifyToken)) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  app.post(
    "/meta-webhook",
    express.raw({ type: "application/json", limit: MAX_WEBHOOK_BYTES }),
    async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
      const signature = text(req.headers["x-hub-signature-256"]);
      try {
        verifyMetaSignature(appSecret, signature, rawBody);
      } catch (err) {
        console.warn(`Meta router rejected webhook signature: ${err.message}`);
        return res.sendStatus(403);
      }

      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch (_) {
        return res.status(400).json({ error: "Invalid Meta webhook JSON." });
      }

      try {
        const routed = await routeRawWebhook({
          body,
          rawBody,
          signature,
          repo,
          fetchImpl,
          timeoutMs,
        });
        if (routed.ignored) return res.sendStatus(200);
        return res.sendStatus(200);
      } catch (err) {
        // Do not acknowledge undelivered customer work. Meta can retry the
        // original signed payload, while client message IDs keep retries safe.
        console.error(`Meta router delivery failed (${err.code || "META_ROUTE_FAILED"}):`, err.message);
        return res.sendStatus(503);
      }
    },
  );

  return app;
}

async function start(env = process.env) {
  const pool = createOpsPool(env);
  await runOpsMigrations(pool);
  const repo = createMetaWebhookRouteRepo(pool);
  const app = createMetaRouterApp({
    repo,
    env,
    healthCheck: () => pool.query("SELECT 1"),
  });
  const port = Number(env.PORT || env.META_ROUTER_PORT || DEFAULT_PORT);
  const server = app.listen(port, () => {
    console.log(`DA Meta webhook router listening on port ${port}`);
  });

  async function shutdown(signal = "shutdown") {
    console.log(`DA Meta webhook router received ${signal}; shutting down.`);
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  }

  process.once("SIGTERM", () => shutdown("SIGTERM").catch((err) => {
    console.error("Meta router shutdown failed:", err);
    process.exitCode = 1;
  }));
  process.once("SIGINT", () => shutdown("SIGINT").catch((err) => {
    console.error("Meta router shutdown failed:", err);
    process.exitCode = 1;
  }));

  return { app, pool, repo, server, shutdown };
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Failed to start DA Meta webhook router:", err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_FORWARD_TIMEOUT_MS,
  DEFAULT_PORT,
  MAX_FORWARD_TIMEOUT_MS,
  boundedPositiveInteger,
  channelForObject,
  collectAssetIds,
  createMetaRouterApp,
  expectedMetaSignature,
  forwardRawWebhook,
  routeRawWebhook,
  start,
  targetWebhookUrl,
  timingSafeTextEqual,
  verifyMetaSignature,
};
