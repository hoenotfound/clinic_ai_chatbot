const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createMigrationLifecycle } = require("../src/utils/migrationLifecycle");
const { migrationIngress, trackExpressHandlers } = require("../src/utils/migrationHttp");
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("client disconnect does not retire an unfinished handler", async t => {
  const http = require("node:http");
  const c = createMigrationLifecycle({ enabled: true }), app = express();
  const entered = deferred(), gate = deferred();
  app.use(migrationIngress(c));
  app.post("/webhook", async (_req, _res) => { entered.resolve(); await gate.promise; });
  trackExpressHandlers(app, c);
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => server.close());
  const request = http.request({ host: "127.0.0.1", port: server.address().port, path: "/webhook", method: "POST" });
  request.on("error", () => {}); request.end(); await entered.promise; request.destroy();
  await new Promise(r => setImmediate(r));
  const drain = c.drain(); assert.equal(c.status().safeToRetire, false);
  gate.resolve(); assert.equal((await drain).safeToRetire, true);
});

test("HTTP ACK does not hide a still-running handler", async t => {
  const c = createMigrationLifecycle({ enabled: true });
  const app = express(), gate = deferred();
  app.use(migrationIngress(c));
  let finished = false;
  app.post("/webhook", async (_req, res) => { res.sendStatus(200); await gate.promise; finished = true; });
  trackExpressHandlers(app, c);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ack = await fetch(base + "/webhook", { method: "POST" }); await ack.text();
  const drain = c.drain();
  assert.equal(finished, false); assert.equal(c.status().safeToRetire, false);
  const held = await fetch(base + "/webhook", { method: "POST" });
  assert.equal(held.status, 503); await held.text();
  const health = await fetch(base + "/");
  assert.equal(health.status, 200); assert.equal((await health.json()).drained, false);
  gate.resolve(); assert.equal((await drain).safeToRetire, true);
  assert.equal(finished, true);
});

test("ordinary promise-returning route functions are tracked after ACK", async t => {
  const c = createMigrationLifecycle({ enabled: true }), app = express(), gate = deferred();
  app.use(migrationIngress(c));
  app.get("/pending", (_req, res) => { res.sendStatus(200); return gate.promise; });
  trackExpressHandlers(app, c);
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => server.close());
  await (await fetch(`http://127.0.0.1:${server.address().port}/pending`)).text();
  const drained = c.drain(); assert.equal(c.status().active, 1);
  gate.resolve(); assert.equal((await drained).safeToRetire, true);
});

test("shared router remains reachable while chatbot ingress is held", async t => {
  const c = createMigrationLifecycle({ enabled: true }), app = express(), router = express();
  router.migrationSharedRouter = true;
  router.post("/other-client", async (_req, res) => res.sendStatus(200));
  app.use("/meta-router", router); app.use(migrationIngress(c));
  app.post("/webhook", (_req, res) => res.sendStatus(200));
  trackExpressHandlers(app, c); await c.drain();
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const forwarded = await fetch(base + "/meta-router/other-client", { method: "POST" });
  assert.equal(forwarded.status, 200); await forwarded.text();
  const held = await fetch(base + "/webhook", { method: "POST" });
  assert.equal(held.status, 503); await held.text();
});
