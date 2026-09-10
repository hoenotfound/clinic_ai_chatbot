const http = require("http");

const DEFAULT_STARTUP_DEADLINE_MS = 180_000;
const DEFAULT_STARTUP_PROBE_INTERVAL_MS = 1_000;
const DEFAULT_STARTUP_WARNING_INTERVAL_MS = 15_000;
const DEFAULT_STARTUP_PROBE_TIMEOUT_MS = 750;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function startupWatchdogOptions(env = process.env) {
  return {
    port: positiveInt(env.PORT, 3000),
    deadlineMs: positiveInt(env.STARTUP_DEADLINE_MS, DEFAULT_STARTUP_DEADLINE_MS),
    probeIntervalMs: positiveInt(
      env.STARTUP_PROBE_INTERVAL_MS,
      DEFAULT_STARTUP_PROBE_INTERVAL_MS
    ),
    warningIntervalMs: positiveInt(
      env.STARTUP_WARNING_INTERVAL_MS,
      DEFAULT_STARTUP_WARNING_INTERVAL_MS
    ),
    probeTimeoutMs: positiveInt(
      env.STARTUP_PROBE_TIMEOUT_MS,
      DEFAULT_STARTUP_PROBE_TIMEOUT_MS
    ),
  };
}

function probeHttpPort({
  port,
  timeoutMs = DEFAULT_STARTUP_PROBE_TIMEOUT_MS,
  httpModule = http,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = httpModule.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        finish(true);
      }
    );

    request.on("error", () => finish(false));
    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
  });
}

function startStartupWatchdog({
  env = process.env,
  log = console.log,
  error = console.error,
  exit = process.exit,
  now = Date.now,
  probe = probeHttpPort,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const options = startupWatchdogOptions(env);
  const startedAt = now();
  let stopped = false;
  let timer = null;
  let lastWarningAt = startedAt;

  log(
    `[Startup] Startup watchdog armed for port ${options.port} ` +
      `(deadline ${options.deadlineMs}ms).`
  );

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeoutFn(timer);
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeoutFn(tick, options.probeIntervalMs);
    timer?.unref?.();
  };

  async function tick() {
    if (stopped) return;

    const listening = await probe({
      port: options.port,
      timeoutMs: options.probeTimeoutMs,
    }).catch(() => false);
    const current = now();
    const elapsedMs = Math.max(0, current - startedAt);

    if (listening) {
      stop();
      log(
        `[Startup] Web server is accepting HTTP connections on port ` +
          `${options.port} after ${elapsedMs}ms.`
      );
      return;
    }

    if (elapsedMs >= options.deadlineMs) {
      stop();
      error(
        `[Startup] Startup deadline exceeded after ${elapsedMs}ms without ` +
          `opening port ${options.port}. Exiting before the platform port-scan ` +
          "timeout; review the last startup/database log above."
      );
      exit(1);
      return;
    }

    if (current - lastWarningAt >= options.warningIntervalMs) {
      lastWarningAt = current;
      log(
        `[Startup] Still waiting for web server port ${options.port} after ` +
          `${elapsedMs}ms.`
      );
    }

    schedule();
  }

  schedule();
  return { options, stop };
}

module.exports = {
  DEFAULT_STARTUP_DEADLINE_MS,
  DEFAULT_STARTUP_PROBE_INTERVAL_MS,
  DEFAULT_STARTUP_PROBE_TIMEOUT_MS,
  DEFAULT_STARTUP_WARNING_INTERVAL_MS,
  probeHttpPort,
  startStartupWatchdog,
  startupWatchdogOptions,
};
