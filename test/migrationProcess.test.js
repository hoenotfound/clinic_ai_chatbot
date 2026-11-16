const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

test("real process signal holds ingress until active work and database close settle", { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, ["-e", `
    const express = require('express');
    const { createMigrationLifecycle } = require('./src/utils/migrationLifecycle');
    const { migrationIngress, trackExpressHandlers } = require('./src/utils/migrationHttp');
    const { installMigrationControl } = require('./src/services/migrationControlService');
    const c = createMigrationLifecycle({ enabled: true }), app = express();
    let release, closed = false;
    const gate = new Promise(r => { release = r; });
    c.registerCloser('synthetic database', async () => { closed = true; });
    app.use(migrationIngress(c));
    app.post('/webhook', async (_req, res) => {
      res.sendStatus(200);
      await gate;
      await c.run('synthetic durable receipt', async () => {});
    });
    trackExpressHandlers(app, c);
    installMigrationControl({ controller: c, writeStatus: state => process.send({ ...state, closed }) });
    const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
    process.on('message', message => { if (message === 'release') release(); });
  `], { cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { child.kill("SIGKILL"); });
  const messages = [], waiters = [];
  child.on("message", message => { messages.push(message); for (const notify of waiters) notify(); });
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Child state was not observed")), 5000);
      function check() {
        const value = messages.find(predicate);
        if (value) { clearTimeout(timeout); waiters.splice(waiters.indexOf(check), 1); resolve(value); }
      }
      waiters.push(check); check();
    });
  }
  const { port } = await waitFor(x => x.port);
  const base = `http://127.0.0.1:${port}`;
  await (await fetch(base + "/webhook", { method: "POST" })).text();
  child.kill("SIGUSR2");
  const draining = await waitFor(x => x.phase === "draining");
  assert.equal(draining.safeToRetire, false); assert.equal(draining.closed, false);
  const retry = await fetch(base + "/webhook", { method: "POST" });
  assert.equal(retry.status, 503); await retry.text();
  child.send("release");
  const held = await waitFor(x => x.phase === "held");
  assert.equal(held.safeToRetire, true); assert.equal(held.closed, true); assert.equal(held.active, 0);
  assert.equal((await (await fetch(base + "/")).json()).drained, true);
});
