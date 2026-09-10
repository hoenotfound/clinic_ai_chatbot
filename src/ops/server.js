require("dotenv").config();

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

const DEFAULT_PORT = 10001;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 60 * 1000;

function pollIntervalMs(env = process.env) {
  const parsed = Number(env.OPS_POLL_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed));
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
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "DENY");
    res.set("Referrer-Policy", "no-referrer");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
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
    res.type("html").send(dashboardHtml());
  });

  app.get("/clients/:clientSlug", (req, res) => {
    res.type("html").send(clientDetailHtml(req.params.clientSlug));
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

  app.post("/api/clients/:clientSlug/refresh", authorizeAction, async (req, res) => {
    try {
      return res.json(await fleetService.refreshClient(req.params.clientSlug));
    } catch (err) {
      if (err?.code === "OPS_CLIENT_NOT_FOUND") {
        return res.status(404).json({ error: err.message });
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

async function start(env = process.env) {
  assertOpsRegistryMode(env);
  const pool = createOpsPool(env);
  await runOpsMigrations(pool);
  const repo = createClientRegistryRepo(pool);
  const poller = createClientPoller({ env });
  const fleetService = createFleetService({ repo, poller, env });
  const authenticate = createRequireOpsAdmin({ env });
  const refreshAll = createSingleFlight(() => fleetService.refreshAll());

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
      await closeServer(server);
      const activeRefresh = refreshAll.inFlight();
      if (activeRefresh) {
        try {
          await activeRefresh;
        } catch (_) {
          // The refresh path already records/logs client failures. Shutdown
          // should still continue and release the database pool.
        }
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
  MIN_POLL_INTERVAL_MS,
  closeServer,
  createOpsRegistryApp,
  createSingleFlight,
  pollIntervalMs,
  start,
};
