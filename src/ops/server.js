require("dotenv").config();

const express = require("express");
const { createOpsPool } = require("./db");
const { runOpsMigrations } = require("./migrationRunner");
const { createClientRegistryRepo } = require("./clientRegistryRepo");
const { createClientPoller } = require("./clientPoller");
const { createFleetService } = require("./fleetService");
const { createRequireOpsAdmin } = require("./requireOpsAdmin");
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

function createOpsRegistryApp({
  fleetService,
  authenticate,
  healthCheck = async () => true,
} = {}) {
  if (!fleetService) throw new Error("fleetService is required.");
  if (typeof authenticate !== "function") throw new Error("Ops Registry admin authentication is required.");

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

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

  app.post("/api/clients/:clientSlug/refresh", async (req, res) => {
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

  app.post("/api/refresh-all", async (_req, res) => {
    try {
      return res.json(await fleetService.refreshAll());
    } catch (err) {
      console.error("Failed to refresh Ops Registry fleet:", err);
      return res.status(500).json({ error: "Could not refresh fleet readiness." });
    }
  });

  return app;
}

async function start(env = process.env) {
  assertOpsRegistryMode(env);
  const pool = createOpsPool(env);
  await runOpsMigrations(pool);
  const repo = createClientRegistryRepo(pool);
  const poller = createClientPoller({ env });
  const fleetService = createFleetService({ repo, poller, env });
  const authenticate = createRequireOpsAdmin({ env });

  const app = createOpsRegistryApp({
    fleetService,
    authenticate,
    healthCheck: () => pool.query("SELECT 1"),
  });

  const port = Number(env.PORT || env.OPS_PORT || DEFAULT_PORT);
  app.listen(port, () => {
    console.log(`DA Ops Registry listening on port ${port}`);
  });

  const refresh = () => fleetService.refreshAll().catch((err) => {
    console.error("Ops Registry background refresh failed:", err);
  });
  refresh();
  setInterval(refresh, pollIntervalMs(env));
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
  createOpsRegistryApp,
  pollIntervalMs,
  start,
};
