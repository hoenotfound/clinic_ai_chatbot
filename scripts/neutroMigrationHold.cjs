#!/usr/bin/env node
"use strict";

// Standalone, opt-in operational process. Do not run through npm start or its
// preloads: those import the chatbot, apply migrations and start dispatchers.
const SOURCE_HOST = "ep-patient-queen-b31tib05.c-4.ap-southeast-1.aws.neon.tech";
const DESTINATION_HOST = "ep-late-dawn-aog3aefy.c-2.ap-southeast-1.aws.neon.tech";
const ROUTER_HOST = "ep-round-glitter-b3jio12y.c-4.ap-southeast-1.aws.neon.tech";
const CLIENT = "neutro-sense-tcm";

function connectionIdentity(value) {
  try {
    const u = new URL(value);
    if (!["postgres:", "postgresql:"].includes(u.protocol)) throw Error();
    return { host: u.hostname.replace("-pooler.", "."), database: u.pathname };
  } catch (_) { throw new Error("Invalid database identity; credential omitted."); }
}

function validateEnvironment(env, execArgv = process.execArgv) {
  if (env.NEUTRO_MIGRATION_HOLD !== "20261116" || env.CLIENT_SLUG !== CLIENT) {
    throw new Error("Explicit Neutro migration hold acknowledgement required.");
  }
  if (String(env.NODE_OPTIONS || "").trim() || execArgv.length) {
    throw new Error("Migration hold must run directly without Node preloads/options.");
  }
  const app = connectionIdentity(env.DATABASE_URL);
  const router = connectionIdentity(env.META_ROUTER_DATABASE_URL);
  if (![SOURCE_HOST, DESTINATION_HOST].includes(app.host) || app.database !== "/neondb") {
    throw new Error("Unexpected Neutro application database identity.");
  }
  if (router.host !== ROUTER_HOST || router.database !== "/neondb") {
    throw new Error("Shared router database identity mismatch.");
  }
  if (env.META_ROUTER_ENABLED !== "true" ||
      (env.META_ROUTER_MOUNT_PATH && env.META_ROUTER_MOUNT_PATH !== "/meta-router")) {
    throw new Error("Verified shared router configuration required.");
  }
  if (!env.META_APP_SECRET || !env.META_VERIFY_TOKEN) {
    throw new Error("Shared router signing and verification configuration required.");
  }
  return { applicationHost: app.host };
}

function createHoldApp({ env, repo, healthCheck, fetchImpl = global.fetch }) {
  // Lazy imports are limited to the existing routing-only implementation.
  const express = require("express");
  const { createMetaRouterApp } = require("../src/metaRouter/server");
  const app = express();
  app.disable("x-powered-by");
  const guardedRepo = {
    async getRoutes(channel, assetIds) {
      const routes = await repo.getRoutes(channel, assetIds);
      // Refuse the entire mixed batch before forwarding any part of it. A
      // false 200 would lose Neutro work; partial forwarding creates retries
      // for other clients. Meta can retry this original signed batch later.
      if (routes.some(r => r.clientSlug === CLIENT ||
        /^(https:\/\/)?(neutrosense\.dasmarketingsolution\.com|da-chatbot-neutro-sense-tcm\.onrender\.com)([/:]|$)/i.test(r.targetBaseUrl))) {
        const error = new Error("Neutro callback temporarily held; retry required.");
        error.code = "NEUTRO_MIGRATION_HOLD";
        throw error;
      }
      return routes;
    },
  };
  app.use("/meta-router", createMetaRouterApp({ repo: guardedRepo, env, healthCheck, fetchImpl }));
  // Existing Render health check is GET /. This checks the holding process,
  // not chatbot readiness or successful worker draining.
  app.get("/", async (_req, res) => {
    try {
      await healthCheck();
      res.set("Cache-Control", "no-store").json({ mode: "migration_hold", chatbotRunning: false });
    } catch (_) { res.sendStatus(503); }
  });
  // No body parser, customer payload storage, logs, acknowledgements, workers,
  // migrations, normal application routes, or automatic timeout/resume.
  app.use((_req, res) => {
    res.set("Retry-After", "60").set("Cache-Control", "no-store");
    res.status(503).json({ error: "temporarily_unavailable" });
  });
  return app;
}

async function main(env = process.env) {
  validateEnvironment(env);
  const { createMetaRouterPool } = require("../src/metaRouter/db");
  const { createMetaWebhookRouteRepo } = require("../src/metaRouter/routeRepo");
  const pool = createMetaRouterPool(env, { allowOpsFallback: false });
  try {
    await pool.query("SELECT 1");
    const app = createHoldApp({ env, repo: createMetaWebhookRouteRepo(pool), healthCheck: () => pool.query("SELECT 1") });
    const port = Number(env.PORT || 10000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
    const server = app.listen(port, "0.0.0.0");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    console.log("NEUTRO_MIGRATION_HOLD_READY: chatbot workers were not started; old instance retirement must be checked separately.");
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      server.close(async () => { await pool.end(); });
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    return { server, pool };
  } catch (error) { await pool.end(); throw error; }
}

if (require.main === module) main().catch(() => {
  console.error("Migration hold startup failed; inspect configuration without exposing credentials.");
  process.exitCode = 1;
});
module.exports = { SOURCE_HOST, DESTINATION_HOST, ROUTER_HOST, CLIENT, connectionIdentity, validateEnvironment, createHoldApp };
