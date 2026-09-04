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

1. acquires a PostgreSQL advisory lock,
2. creates/reads `schema_migrations`,
3. verifies already-applied migration names and checksums,
4. applies only missing migrations in order,
5. records each successful migration in the same transaction,
6. releases the advisory lock, then continues normal server startup.

This makes repeated Render restarts safe and prevents two app instances from migrating the same client database at the same time.
