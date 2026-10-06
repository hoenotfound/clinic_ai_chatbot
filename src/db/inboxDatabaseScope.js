const { AsyncLocalStorage } = require("node:async_hooks");

const scopeStorage = new AsyncLocalStorage();

// Inbox-only settings. Background AI, migrations and retention workers continue
// using their existing pool behaviour. Server-side deadlines cancel SQL rather
// than merely abandoning a Promise while its writes are still running.
async function acquireScopedClient(database, scope) {
  const startedAt = performance.now();
  const client = await database.connect();
  scope.timings.dbPoolMs = (scope.timings.dbPoolMs || 0) +
    Math.round(performance.now() - startedAt);
  let previous;
  try {
    const settings = await client.query(
      "SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock"
    );
    previous = settings.rows[0];
    await client.query(
      "SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)",
      [`${scope.statementTimeoutMs}ms`, `${scope.lockTimeoutMs}ms`]
    );
  } catch (error) {
    client.release(error);
    throw error;
  }
  let released = false;
  return new Proxy(client, {
    get(target, key) {
      if (key === "release") return async (error) => {
        if (released) return;
        released = true;
        if (error) return client.release(error);
        try {
          await client.query(
            "SELECT set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)",
            [previous.statement, previous.lock]
          );
          client.release();
        } catch (resetError) {
          // A connection with uncertain session state must never be reused.
          client.release(resetError);
        }
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createScopedPool(database) {
  return new Proxy(database, {
    get(target, key) {
      if (key === "query") return (...args) => {
        const scope = scopeStorage.getStore();
        if (!scope || scope.closed) return database.query(...args);
        // Reuse one connection for the short bookkeeping block. Dedicated
        // transaction/alert-lock clients remain separate, preserving lock order.
        const run = scope.tail.catch(() => {}).then(async () => {
          scope.clientPromise ||= acquireScopedClient(database, scope);
          const client = await scope.clientPromise;
          return client.query(...args);
        });
        scope.tail = run.catch(() => {});
        return run;
      };
      if (key === "connect") return (...args) => {
        const scope = scopeStorage.getStore();
        if (!scope || scope.closed) return database.connect(...args);
        const callback = args[0];
        const pending = acquireScopedClient(database, scope);
        if (typeof callback === "function") {
          pending.then(
            (client) => callback(null, client, client.release),
            (error) => callback(error)
          );
          return;
        }
        return pending;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function withInboxDatabaseTimeouts(work, timings = {}, options = {}) {
  if (scopeStorage.getStore()) return work();
  const scope = {
    timings,
    statementTimeoutMs: options.statementTimeoutMs || 10000,
    lockTimeoutMs: options.lockTimeoutMs || 5000,
    tail: Promise.resolve(),
    clientPromise: null,
    closed: false,
  };
  return scopeStorage.run(scope, async () => {
    try {
      return await work();
    } finally {
      await scope.tail;
      scope.closed = true;
      if (scope.clientPromise) {
        const client = await scope.clientPromise.catch(() => null);
        if (client) await client.release();
      }
    }
  });
}

module.exports = { createScopedPool, withInboxDatabaseTimeouts };
