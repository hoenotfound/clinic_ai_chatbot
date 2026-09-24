# Database migrations

Database schema changes are versioned and applied automatically before the server starts accepting traffic.

## Baseline

Versions **001–011** are the historical schema files in `src/db/` that existed when versioned migrations were introduced. They are intentionally kept in their original locations and guarded by immutable Git blob hashes in `migrationRunner.js`.

Do **not** edit those historical schema files for future database changes. Existing databases execute the idempotent baseline one final time and record it in `schema_migrations`; fresh databases use the same baseline to build the current schema from zero.

## Adding a new migration

All new database changes belong in this directory. Use the next contiguous version and snake_case name, for example:

```text
012_add_contact_tags.sql
013_add_message_search_index.sql
```

The runner rejects gaps, duplicate migration names, renamed/applied migrations, and checksum drift.

## Rules

- Migrations are forward-only. Do not rewrite an already-applied migration.
- Do not put `BEGIN`, `COMMIT`, or `ROLLBACK` inside a migration file; the runner wraps each migration in its own transaction.
- Keep migrations compatible with PostgreSQL transactions. If a future operation cannot run in a transaction (for example `CREATE INDEX CONCURRENTLY`), extend the runner deliberately rather than bypassing it.
- Prefer additive/rolling-deploy-safe changes when old and new app instances may briefly overlap during deployment.
- Data backfills that are required by the new schema belong in the migration so the schema and data move forward together.
- A failed migration intentionally prevents the server from starting. Fix the migration/database issue instead of allowing the app to run against a partially upgraded schema.

## Runtime behavior

On startup the app:

1. begins a migration transaction,
2. acquires a transaction-scoped PostgreSQL advisory lock,
3. creates/reads `schema_migrations`,
4. verifies already-applied migration names and checksums,
5. applies at most one missing migration and records it in that same transaction,
6. commits, which automatically releases the advisory lock,
7. repeats until the migration history is current, then continues normal server startup.

The runner deliberately uses `pg_try_advisory_xact_lock` rather than a session-level advisory lock. This keeps the lock bound to the same transaction/backend when `DATABASE_URL` is a Neon pooled (PgBouncer transaction-pooling) connection and prevents stale session locks from being stranded in the pool.

This makes repeated Render restarts safe and prevents two app instances from applying the same migration at the same time.
