"use strict";
const { lifecycle } = require("./migrationLifecycle");

function trackedInterval(run, delay, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval) {
  if (!lifecycle.enabled) return setIntervalImpl(run, delay);
  if (!lifecycle.accepting()) return null;
  const timer = setIntervalImpl(() => {
    if (!lifecycle.accepting()) return;
    try {
      const result = lifecycle.run("maintenance interval", run);
      result?.catch?.(() => lifecycle.fault());
    } catch (_) { lifecycle.fault(); }
  }, delay);
  lifecycle.registerStop(timer, () => clearIntervalImpl(timer));
  return timer;
}
module.exports = { trackedInterval };
