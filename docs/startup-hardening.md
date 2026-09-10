# Startup hardening

The production chatbot must bind its Render web port promptly. A database connection, migration lock, or later bootstrap stall must not leave the deploy silent until Render's platform-level port scan times out.

## Defaults

The chatbot now uses these bounded startup controls:

- `DATABASE_CONNECT_TIMEOUT_MS=10000` — maximum PostgreSQL pool connection wait.
- `DATABASE_MIGRATION_LOCK_TIMEOUT_MS=30000` — maximum time startup waits for the database migration advisory lock.
- `DATABASE_MIGRATION_LOCK_RETRY_MS=250` — retry interval while another instance owns the migration lock.
- `STARTUP_DEADLINE_MS=180000` — maximum time from `npm start` until the web port accepts HTTP connections.
- `STARTUP_PROBE_INTERVAL_MS=1000` — local port-probe interval used by the startup watchdog.
- `STARTUP_WARNING_INTERVAL_MS=15000` — cadence for "still waiting" startup diagnostics.
- `STARTUP_PROBE_TIMEOUT_MS=750` — timeout for each local HTTP probe.

All values are optional. The defaults are intended for Render + Neon and should normally be left unchanged. Increase a limit only when a known deployment needs more time; do not use a larger timeout to hide a persistent startup problem.

## Expected Render logs

A healthy restart should show messages similar to:

```text
[Startup] Startup watchdog armed for port 10000 (deadline 180000ms).
[Startup] Database initialization started (connect timeout 10000ms, migration lock timeout 30000ms).
[Startup] Waiting for database migration lock (max 30000ms)...
[Startup] Database migration lock acquired.
[Startup] Database migrations ready at version 15 (0 applied, 15 already current).
[Startup] Database initialization complete at migration version 15 (...ms).
Server listening on port 10000
[Startup] Web server is accepting HTTP connections on port 10000 after ...ms.
```

If another deploy or process holds the migration lock for too long, startup exits with `MIGRATION_LOCK_TIMEOUT` instead of waiting indefinitely. If any later bootstrap step stalls and the web port still has not opened by `STARTUP_DEADLINE_MS`, the watchdog exits the process with a clear startup-deadline message so Render can fail/retry the deployment rather than waiting for the full platform port-scan timeout.

## What this does not change

Startup hardening does not alter message delivery, AI routing, webhook handling, follow-ups, lead scoring, or Ops Registry polling. The Ops Registry uses its own start command and is not affected by the chatbot web-start watchdog.
