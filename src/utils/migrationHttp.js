"use strict";

const { lifecycle: defaultLifecycle } = require("./migrationLifecycle");
const WRAPPED = Symbol("migration-tracked-handler");

function migrationIngress(lifecycle = defaultLifecycle) {
  const ingress = (req, res, next) => {
    if (!lifecycle.enabled) return next();
    if (!lifecycle.accepting()) {
      res.set("Cache-Control", "no-store");
      if (req.method === "GET" && req.path === "/") {
        const state = lifecycle.status();
        return res.json({ mode: state.safeToRetire ? "migration_hold" : "migration_draining",
          acceptingWork: false, activeTasks: state.active, drained: state.safeToRetire });
      }
      return res.set("Retry-After", "60").status(503).json({ error: "temporarily_unavailable" });
    }
    const request = lifecycle.enter("HTTP request");
    // Handler promises are tracked separately below, including after disconnect
    // or HTTP ACK. A finished socket does not mean application work finished.
    res.once("finish", request.release);
    res.once("close", request.release);
    return request.run(next);
  };
  ingress.migrationIngress = true;
  return ingress;
}

function trackExpressHandlers(app, lifecycle = defaultLifecycle, seen = new Set()) {
  if (!lifecycle.enabled || !app || seen.has(app) || app.migrationSharedRouter) return;
  seen.add(app);
  const layers = app.stack || app._router?.stack || [];
  const ingressIndex = layers.findIndex(layer => layer.handle?.migrationIngress);
  for (const [index, layer] of layers.entries()) {
    // Query parsing/Express initialization precede our guard. Let the guard
    // answer a held request before trying to enter any tracked task.
    if (ingressIndex >= 0 && index <= ingressIndex) continue;
    if (layer.route) { trackExpressHandlers(layer.route, lifecycle, seen); continue; }
    const handler = layer.handle;
    if (!handler || handler[WRAPPED] || handler.migrationSharedRouter) continue;
    if (handler.stack || handler._router) { trackExpressHandlers(handler, lifecycle, seen); continue; }
    // Includes ordinary functions returning promises, not just async syntax.
    const invoke = (args, next) => {
      try { return lifecycle.run("HTTP handler", () => handler(...args)); }
      catch (error) { return next(error); }
    };
    const wrapped = handler.length === 4
      ? function (error, req, res, next) { return invoke([error, req, res, next], next); }
      : function (req, res, next) { return invoke([req, res, next], next); };
    wrapped[WRAPPED] = true;
    layer.handle = wrapped;
  }
}

module.exports = { migrationIngress, trackExpressHandlers };
