const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMigrationLifecycle, validateMigrationEnvironment, trackMethods } = require("../src/utils/migrationLifecycle");
const { createAdaptiveWorkerTimer } = require("../src/utils/adaptiveWorkerTimer");
const { instrumentDatabase } = require("../src/db/migrationDatabase");
const { installMigrationControl } = require("../src/services/migrationControlService");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("disabled control preserves exact method and result identities", () => {
  const c = createMigrationLifecycle();
  const result = Promise.resolve(5), fn = () => result, obj = { fn };
  assert.equal(c.run("test", fn), result);
  assert.equal(trackMethods(obj, ["fn"], "send", c).fn, fn);
  assert.equal(c.status().safeToRetire, false);
});

test("drain waits for the active send AND its subsequent durable outcome write", async () => {
  const c = createMigrationLifecycle({ enabled: true });
  const provider = deferred(), database = deferred();
  const order = [];
  c.registerCloser("pool", () => { order.push("pool closed"); });
  const task = c.run("reply task", async () => {
    await provider.promise;
    await c.run("outcome write", async () => { order.push("outcome write"); await database.promise; });
  });
  const drained = c.drain();
  assert.equal(c.status().safeToRetire, false);
  assert.throws(() => c.run("new send", () => { throw Error("must never run"); }), { code: "MIGRATION_DRAINING" });
  provider.resolve(); await tick();
  assert.deepEqual(order, ["outcome write"]);
  assert.equal(c.status().phase, "draining");
  database.resolve(); await task;
  assert.equal((await drained).safeToRetire, true);
  assert.deepEqual(order, ["outcome write", "pool closed"]);
  assert.equal(c.drain(), drained);
});

test("tracked detached work survives parent completion and blocks retirement", async () => {
  const c = createMigrationLifecycle({ enabled: true }), delayed = deferred();
  let detached;
  c.run("webhook handler", () => { detached = c.run("receipt side effects", () => delayed.promise); });
  const drained = c.drain();
  assert.equal(c.status().active, 1);
  delayed.resolve(); await detached;
  assert.equal((await drained).phase, "held");
});

test("actual adaptive timer cannot restart or overlap work while draining", async () => {
  const c = createMigrationLifecycle({ enabled: true }), gate = deferred();
  let callback, executions = 0, schedules = 0;
  const worker = createAdaptiveWorkerTimer({ lifecycle: c, label: "synthetic worker",
    run: async () => { executions++; await gate.promise; }, delayForResult: () => 0,
    setTimeoutImpl: fn => { callback = fn; schedules++; return { unref() {} }; }, clearTimeoutImpl() {} });
  worker.start(); const active = callback();
  const drain = c.drain();
  assert.equal(worker.state().stopped, true);
  assert.equal(worker.state().running, true);
  assert.equal(worker.wake(0), false);
  worker.start(); assert.equal(schedules, 1);
  gate.resolve(); await active; await drain;
  assert.equal(executions, 1); assert.equal(worker.state().running, false);
  assert.equal(c.status().safeToRetire, true);
});

test("failed stop or database close blocks safe retirement", async () => {
  for (const type of ["stop", "close"]) {
    const c = createMigrationLifecycle({ enabled: true });
    if (type === "stop") c.registerStop("broken", () => { throw Error("failed"); });
    else c.registerCloser("broken", async () => { throw Error("failed"); });
    const result = await c.drain();
    assert.equal(result.safeToRetire, false);
    assert.equal(result.phase, "blocked");
  }
});

test("database guard waits for promise and callback queries then refuses late access", async () => {
  const c = createMigrationLifecycle({ enabled: true }), query = deferred();
  const db = Object.assign(new EventEmitter(), {
    query(...args) { const cb = args.at(-1); if (typeof cb === "function") { query.promise.then(x => cb(null, x)); return undefined; } return query.promise; },
    connect: async () => ({}), end: async () => { db.closed = true; },
  });
  instrumentDatabase(db, c);
  const pending = db.query("synthetic");
  let callbackResult;
  db.query("synthetic", (err, value) => { assert.equal(err, null); callbackResult = value; });
  const drain = c.drain();
  assert.equal(db.closed, undefined);
  query.resolve("ok"); await pending; await tick();
  assert.equal(callbackResult, "ok");
  assert.equal((await drain).safeToRetire, true);
  assert.throws(() => db.query("late"), /paused/);
  assert.equal(c.status().safeToRetire, false);
});

test("pool closure itself must settle before safe retirement", async () => {
  const c = createMigrationLifecycle({ enabled: true }), pool = deferred();
  c.registerCloser("pool", () => pool.promise);
  const drained = c.drain();
  assert.equal(c.status().phase, "closing");
  assert.equal(c.status().safeToRetire, false);
  pool.resolve(); assert.equal((await drained).phase, "held");
});

test("private signal control is one-way and keeps status heartbeat after holding", async () => {
  const c = createMigrationLifecycle({ enabled: true });
  const fakeProcess = Object.assign(new EventEmitter(), { pid: 123 });
  const writes = []; let heartbeat, clears = 0;
  const control = installMigrationControl({ controller: c, processImpl: fakeProcess,
    writeStatus: s => writes.push(s), setIntervalImpl: fn => { heartbeat = fn; return { unref() {} }; },
    clearIntervalImpl: () => { clears++; } });
  fakeProcess.emit("SIGUSR2"); await tick();
  assert.equal(writes.at(-1).safeToRetire, true);
  assert.equal(clears, 0);
  c.fault(); heartbeat();
  assert.equal(writes.at(-1).safeToRetire, false);
  assert.equal(writes.at(-1).pid, 123);
  control.dispose();
  assert.equal(fakeProcess.listenerCount("SIGUSR2"), 0);
});

test("control opt-in rejects another client or enabled one-off send jobs", () => {
  assert.equal(validateMigrationEnvironment({}), false);
  const env = { NEUTRO_MIGRATION_CONTROL: "20261116", CLIENT_SLUG: "neutro-sense-tcm",
    DATABASE_URL: "postgresql://synthetic@ep-patient-queen-b31tib05.c-4.ap-southeast-1.aws.neon.tech/neondb" };
  assert.equal(validateMigrationEnvironment(env), true);
  assert.throws(() => validateMigrationEnvironment({ ...env, CLIENT_SLUG: "other" }));
  assert.throws(() => validateMigrationEnvironment({ ...env, NEUTRO_PULSE_RECOVERY_SEND_ENABLED: "true" }));
});
