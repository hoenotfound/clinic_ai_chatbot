"use strict";

// Opt-in operational control. No SQL, customer identifiers or provider calls.
const { AsyncLocalStorage } = require("node:async_hooks");

function createMigrationLifecycle({ enabled = false, onChange = () => {} } = {}) {
  const context = new AsyncLocalStorage();
  const active = new Set();
  const stops = new Map();
  const closers = new Map();
  let phase = "running", faults = 0, drainPromise, resolveDrain, closing = false, stopping = false;
  const labelOf = label => /^[A-Za-z0-9 _-]{1,64}$/.test(label) ? label : "application task";
  function status() {
    const counts = {};
    for (const item of active) counts[item.label] = (counts[item.label] || 0) + 1;
    return { enabled, phase, active: active.size, tasks: counts, faults,
      safeToRetire: enabled && phase === "held" && faults === 0 };
  }
  function changed() { try { onChange(status()); } catch (_) { faults++; } }
  function failed() { faults++; changed(); }
  function denied() {
    const error = new Error("Application work is paused for database migration.");
    error.code = "MIGRATION_DRAINING";
    return error;
  }
  function accepting() { return !enabled || phase === "running"; }
  function permitted() { return accepting() || (phase === "draining" && context.getStore()?.open); }
  async function finish() {
    if (!enabled || phase !== "draining" || closing || stopping || active.size) return;
    closing = true;
    phase = "closing";
    changed();
    for (const close of closers.values()) {
      try { await close(); } catch (_) { failed(); }
    }
    phase = faults ? "blocked" : "held";
    changed();
    resolveDrain(status());
  }
  function enter(label) {
    if (!enabled) return { run: fn => fn(), release() {} };
    if (!permitted()) throw denied();
    const item = { label: labelOf(label), open: true };
    active.add(item);
    changed();
    return {
      run: fn => context.run(item, fn),
      release() {
        if (!item.open) return;
        item.open = false;
        active.delete(item);
        changed();
        void finish();
      },
    };
  }
  function run(label, fn) {
    if (!enabled) return fn();
    const token = enter(label);
    let value;
    try { value = token.run(fn); } catch (error) { token.release(); throw error; }
    if (value && typeof value.then === "function") {
      // Preserve the caller's exact result and rejection behavior.
      value.then(() => token.release(), () => token.release());
    } else token.release();
    return value;
  }
  function registerStop(key, stop) {
    if (!enabled) return () => {};
    if (accepting()) stops.set(key, stop);
    else { try { stop(); } catch (_) { failed(); } }
    return () => stops.delete(key);
  }
  function registerCloser(key, close) {
    if (!enabled) return;
    if (closing) { failed(); throw Error("Resource registered after migration close began."); }
    closers.set(key, close);
  }
  function drain() {
    if (!enabled) return Promise.reject(Error("Migration control is disabled."));
    if (drainPromise) return drainPromise;
    drainPromise = new Promise(resolve => { resolveDrain = resolve; });
    phase = "draining";
    stopping = true;
    // Stop registration is synchronous: no new timer callback can interleave.
    for (const stop of stops.values()) {
      try { stop(); } catch (_) { failed(); }
    }
    stops.clear();
    stopping = false;
    changed();
    void finish();
    return drainPromise;
  }
  return { enabled, status, accepting, permitted, enter, run, registerStop,
    registerCloser, drain, fault: failed };
}

function validateMigrationEnvironment(env) {
  if (env.NEUTRO_MIGRATION_CONTROL !== "20261116") return false;
  const hosts = new Set([
    "ep-patient-queen-b31tib05.c-4.ap-southeast-1.aws.neon.tech",
    "ep-late-dawn-aog3aefy.c-2.ap-southeast-1.aws.neon.tech",
  ]);
  let valid = false;
  try {
    const url = new URL(env.DATABASE_URL);
    valid = ["postgres:", "postgresql:"].includes(url.protocol) &&
      hosts.has(url.hostname.replace("-pooler.", ".")) && url.pathname === "/neondb";
  } catch (_) {}
  if (env.CLIENT_SLUG !== "neutro-sense-tcm" || !valid ||
      env.NEUTRO_PULSE_RECOVERY_SEND_ENABLED === "true" ||
      env.NEUTRO_PULSE_REENCODE_ENABLED === "true" || env.PR395_STAGING_MODE === "true") {
    throw Error("Migration control requires the reviewed Neutro identity and disabled one-off recovery jobs.");
  }
  return true;
}

const lifecycle = createMigrationLifecycle({ enabled: validateMigrationEnvironment(process.env) });
function trackMethods(object, names, label, controller = lifecycle) {
  if (!controller.enabled) return object;
  for (const name of names) {
    const original = object[name];
    if (typeof original !== "function") throw Error("Missing migration-tracked method.");
    object[name] = function (...args) { return controller.run(label, () => original.apply(this, args)); };
  }
  return object;
}
module.exports = { createMigrationLifecycle, validateMigrationEnvironment, lifecycle, trackMethods };
