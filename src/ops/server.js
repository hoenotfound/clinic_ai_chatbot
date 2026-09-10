require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const { createOpsPool } = require("./db");
const { runOpsMigrations } = require("./migrationRunner");
const { createClientRegistryRepo } = require("./clientRegistryRepo");
const { createClientPoller } = require("./clientPoller");
const { createFleetService } = require("./fleetService");
const { createRequireOpsAdmin } = require("./requireOpsAdmin");
const { createRequireOpsAction } = require("./requireOpsAction");
const { clientDetailHtml, dashboardHtml } = require("./dashboard");
const { assertOpsRegistryMode } = require("./mode");
const {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  pollIntervalMs,
} = require("./runtimeConfig");

const DEFAULT_PORT = 10001;
const DEFAULT_SHUTDOWN_GRACE_MS = 100 * 1000;
const MAX_SHUTDOWN_GRACE_MS = 110 * 1000;

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shutdownGraceMs(env = process.env) {
  return boundedPositiveInteger(
    env.OPS_SHUTDOWN_GRACE_MS,
    DEFAULT_SHUTDOWN_GRACE_MS,
    { min: 5000, max: MAX_SHUTDOWN_GRACE_MS },
  );
}

function createSingleFlight(task) {
  if (typeof task !== "function") throw new TypeError("Single-flight task must be a function.");
  let inFlight = null;

  function run() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(task)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  run.inFlight = () => inFlight;
  return run;
}

function securityNonce() {
  return crypto.randomBytes(16).toString("base64");
}

function createOpsRegistryApp({
  fleetService,
  authenticate,
  authorizeAction = createRequireOpsAction(),
  healthCheck = async () => true,
  refreshAll = null,
} = {}) {
  if (!fleetService) throw new Error("fleetService is required.");
  if (typeof authenticate !== "function") throw new Error("Ops Registry admin authentication is required.");
  if (typeof authorizeAction !== "function") throw new Error("Ops Registry action authorization is required.");

  const runFleetRefresh = typeof refreshAll === "function"
    ? refreshAll
    : () => fleetService.refreshAll();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use((_req, res, next) => {
    const nonce = securityNonce();
    res.locals.cspNonce = nonce;
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`,
    );
    next();
  });

  app.get("/healthz", async (_req, res) => {
    try {
      await healthCheck();
      return res.json({ ok: true });
    } catch (_) {
      return res.status(503).json({ ok: false });
    }
  });

  app.use(authenticate);

  app.get("/", (_req, res) => {
    res.type("html").send(dashboardHtml(res.locals.cspNonce));
  });

  app.get("/clients/:clientSlug", (req, res) => {
    res.type("html").send(clientDetailHtml(req.params.clientSlug, res.locals.cspNonce));
  });

  app.get("/api/clients", async (_req, res) => {
    try {
      return res.json(await fleetService.listFleet());
    } catch (err) {
      console.error("Failed to list Ops Registry clients:", err);
      return res.status(500).json({ error: "Could not load client registry." });
    }
  });

  app.get("/api/clients/:clientSlug", async (req, res) => {
    try {
      const client = await fleetService.getClient(req.params.clientSlug);
      if (!client) return res.status(404).json({ error: "Client not found." });
      return res.json(client);
    } catch (err) {
      console.error("Failed to load Ops Registry client:", err);
      return res.status(500).json({ error: "Could not load client." });
    }
  });

  app.post("/api/clients/:clientSlug/lifecycle", authorizeAction, async (req, res) => {
    try {
      return res.json(await fleetService.setClientLifecycle(
        req.params.clientSlug,
        req.body?.lifecycleStatus,
      ));
    } catch (err) {
      if (err?.code === "OPS_CLIENT_NOT_FOUND") {
        return res.status(404).json({ error: err.message });
      }
      if (err?.code === "OPS_CLIENT_LIFECYCLE_INVALID") {
        return res.status(400).json({ error: err.message });
      }
      console.error("Failed to update Ops Registry client lifecycle:", err);
      return res.status(500).json({ error: "Could not update client lifecycle." });
    }
  });

  app.post("/api/clients/:clientSlug/refresh", authorizeAction, async (req, res) => {
    try {
      return res.json(await fleetService.refreshClient(req.params.clientSlug));
    } catch (err) {
      if (err?.code === "OPS_CLIENT_NOT_FOUND") {
        return res.status(404).json({ error: err.message });
      }
      if (err?.code === "OPS_CLIENT_PAUSED") {
        return res.status(409).json({ error: err.message });
      }
      console.error("Failed to refresh Ops Registry client:", err);
      return res.status(500).json({ error: "Could not refresh client readiness." });
    }
  });

  app.post("/api/refresh-all", authorizeAction, async (_req, res) => {
    try {
      return res.json(await runFleetRefresh());
    } catch (err) {
      console.error("Failed to refresh Ops Registry fleet:", err);
      return res.status(500).json({ error: "Could not refresh fleet readiness." });
    }
  });

  return app;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function start(env = process.env) {
  assertOpsRegistryMode(env);
  const pool = createOpsPool(env);
  await runOpsMigrations(pool);
  const repo = createClientRegistryRepo(pool);
  const poller = createClientPoller({ env });
  const fleetService = createFleetService({ repo, poller, env });
  const authenticate = createRequireOpsAdmin({ env });
  const refreshAbortController = new AbortController();
  const refreshAll = createSingleFlight(() => fleetService.refreshAll({
    signal: refreshAbortController.signal,
  }));

  const app = createOpsRegistryApp({
    fleetService,
    authenticate,
    healthCheck: () => pool.query("SELECT 1"),
    refreshAll,
  });

  const port = Number(env.PORT || env.OPS_PORT || DEFAULT_PORT);
  const server = app.listen(port, () => {
    console.log(`DA Ops Registry listening on port ${port}`);
  });

  const backgroundRefresh = () => refreshAll().catch((err) => {
    console.error("Ops Registry background refresh failed:", err);
  });
  backgroundRefresh();
  const refreshTimer = setInterval(backgroundRefresh, pollIntervalMs(env));
  refreshTimer.unref?.();

  let shutdownPromise = null;
  const onSignal = (signal) => {
    shutdown(signal).catch((err) => {
      console.error("Ops Registry shutdown failed:", err);
      process.exitCode = 1;
    });
  };

  async function shutdown(signal = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`DA Ops Registry received ${signal}; shutting down.`);
      clearInterval(refreshTimer);
      process.removeListener("SIGTERM", sigtermHandler);
      process.removeListener("SIGINT", sigintHandler);
      refreshAbortController.abort();
      server.closeIdleConnections?.();

      const activeRefresh = refreshAll.inFlight();
      const gracefulWork = Promise.allSettled([
        closeServer(server),
        activeRefresh || Promise.resolve(),
      ]);
      const graceful = await settleWithin(gracefulWork, shutdownGraceMs(env));
      if (!graceful) {
        console.error("Ops Registry graceful shutdown deadline reached; closing remaining HTTP connections.");
        server.closeAllConnections?.();
      }

      await pool.end();
    })();
    return shutdownPromise;
  }

  const sigtermHandler = () => onSignal("SIGTERM");
  const sigintHandler = () => onSignal("SIGINT");
  process.once("SIGTERM", sigtermHandler);
  process.once("SIGINT", sigintHandler);

  return {
    app,
    fleetService,
    pool,
    refreshAbortController,
    refreshAll,
    refreshTimer,
    server,
    shutdown,
  };
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Failed to start DA Ops Registry:", err);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  MAX_SHUTDOWN_GRACE_MS,
  MIN_POLL_INTERVAL_MS,
  boundedPositiveInteger,
  closeServer,
  createOpsRegistryApp,
  createSingleFlight,
  pollIntervalMs,
  securityNonce,
  settleWithin,
  shutdownGraceMs,
  start,
};
