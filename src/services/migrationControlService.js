"use strict";

const fs = require("node:fs");
const { lifecycle } = require("../utils/migrationLifecycle");
const STATUS_PATH = "/tmp/neutro-migration-drain-status.json";

function installMigrationControl({ controller = lifecycle, processImpl = process,
  writeStatus = data => {
    // No credentials or customer data. Atomic replacement, owner-only access.
    const temp = STATUS_PATH + "." + processImpl.pid;
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "w" });
    fs.renameSync(temp, STATUS_PATH);
  }, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (!controller.enabled) return null;
  let signalled = false, timer;
  function publish() {
    try { writeStatus({ pid: processImpl.pid, observedAt: new Date().toISOString(), ...controller.status() }); }
    catch (_) { controller.fault(); }
  }
  function drain() {
    if (signalled) return;
    signalled = true;
    // One-way hold. There is deliberately no resume endpoint or timeout that
    // restarts senders. Only a separate reviewed process can resume service.
    const pending = controller.drain();
    publish();
    timer = setIntervalImpl(publish, 1000);
    timer.unref?.();
    // Keep a heartbeat after holding too. A failed/late operation must not
    // leave a stale successful status file looking current.
    pending.then(publish);
  }
  processImpl.on("SIGUSR2", drain);
  publish();
  return { drain, dispose() { processImpl.removeListener("SIGUSR2", drain); clearIntervalImpl(timer); } };
}

module.exports = { installMigrationControl, STATUS_PATH };
