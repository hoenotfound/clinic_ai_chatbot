/**
 * One-time backfill: uploads every message's existing media_base64 bytes to
 * R2, records the resulting object key in media_key, and clears
 * media_base64 so the row actually reclaims space in Postgres/Neon.
 *
 * Usage:
 *   node scripts/migrateMediaToR2.js            # migrates everything
 *   node scripts/migrateMediaToR2.js --dry-run  # reports what it would do
 *
 * Safe to re-run: it only ever selects rows where media_base64 IS NOT NULL
 * AND media_key IS NULL, so already-migrated rows are skipped.
 */

require("dotenv").config();
const { pool } = require("../src/db/db");
const mediaStorage = require("../src/services/mediaStorageService");

const BATCH_SIZE = 25;
const dryRun = process.argv.includes("--dry-run");

async function migrateBatch() {
  const { rows } = await pool.query(
    `SELECT id, contact_id, media_base64, media_mime_type
     FROM messages
     WHERE media_base64 IS NOT NULL AND media_key IS NULL
     ORDER BY id ASC
     LIMIT $1`,
    [BATCH_SIZE]
  );

  for (const row of rows) {
    if (dryRun) {
      console.log(`[dry-run] would migrate message ${row.id} (contact ${row.contact_id})`);
      continue;
    }

    try {
      const buffer = Buffer.from(row.media_base64, "base64");
      const key = await mediaStorage.uploadMedia(buffer, row.media_mime_type, {
        contactId: row.contact_id,
      });
      await pool.query(
        `UPDATE messages SET media_key = $2, media_base64 = NULL WHERE id = $1`,
        [row.id, key]
      );
      console.log(`Migrated message ${row.id} -> ${key}`);
    } catch (err) {
      // Leave media_base64 in place on failure so this row is retried next run.
      console.error(`Failed to migrate message ${row.id}:`, err.message);
    }
  }

  return rows.length;
}

async function main() {
  let totalMigrated = 0;
  let batchCount;
  do {
    batchCount = await migrateBatch();
    totalMigrated += batchCount;
  } while (batchCount === BATCH_SIZE);

  console.log(
    dryRun
      ? `Dry run complete. ${totalMigrated} row(s) would be migrated.`
      : `Migration complete. ${totalMigrated} row(s) migrated.`
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
