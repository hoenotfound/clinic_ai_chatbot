"use strict";
const { lifecycle } = require("../utils/migrationLifecycle");

function instrumentDatabase(database, controller = lifecycle) {
  if (!controller.enabled) return database;
  function wrap(target, method, label) {
    const original = target[method];
    target[method] = function (...args) {
      if (!controller.permitted()) { controller.fault(); throw Error("Application database is paused."); }
      const callbackIndex = args.length - 1;
      if (typeof args[callbackIndex] !== "function") {
        return controller.run(label, () => original.apply(this, args));
      }
      const token = controller.enter(label);
      const callback = args[callbackIndex];
      args[callbackIndex] = (...values) => {
        try { return token.run(() => callback(...values)); }
        finally { token.release(); }
      };
      try { return token.run(() => original.apply(this, args)); }
      catch (error) { token.release(); throw error; }
    };
  }
  wrap(database, "query", "database query");
  wrap(database, "connect", "database acquisition");
  database.on("connect", client => wrap(client, "query", "database client query"));
  controller.registerCloser(database, () => database.end());
  return database;
}
module.exports = { instrumentDatabase };
