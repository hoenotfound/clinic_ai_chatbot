const { pool } = require("./db");

const MAX_CONFIG_IMPORT_SNAPSHOTS = 50;

async function pruneOldSnapshots(database, keep = MAX_CONFIG_IMPORT_SNAPSHOTS) {
  const safeKeep = Math.min(
    MAX_CONFIG_IMPORT_SNAPSHOTS,
    Math.max(1, Number(keep) || MAX_CONFIG_IMPORT_SNAPSHOTS)
  );
  await database.query(
    `DELETE FROM config_import_snapshots
     WHERE id IN (
       SELECT id
       FROM config_import_snapshots
       ORDER BY created_at DESC, id DESC
       OFFSET $1
     )`,
    [safeKeep]
  );
}

async function createSnapshot({
  editableConfig,
  createdBy,
  reason,
  restoredFromSnapshotId = null,
}) {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;

    const result = await client.query(
      `INSERT INTO config_import_snapshots (
         editable_config, created_by, reason, restored_from_snapshot_id
       )
       VALUES ($1::jsonb, $2, $3, $4)
       RETURNING id, editable_config, created_by, reason, restored_from_snapshot_id, created_at`,
      [
        JSON.stringify(editableConfig || {}),
        String(createdBy || "admin"),
        reason,
        restoredFromSnapshotId,
      ]
    );

    await pruneOldSnapshots(client);
    await client.query("COMMIT");
    inTransaction = false;
    return result.rows[0];
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listSnapshots(limit = 12) {
  const safeLimit = Math.min(
    MAX_CONFIG_IMPORT_SNAPSHOTS,
    Math.max(1, Number(limit) || 12)
  );
  const result = await pool.query(
    `SELECT id, editable_config, created_by, reason, restored_from_snapshot_id, created_at
     FROM config_import_snapshots
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

async function getSnapshot(id) {
  const result = await pool.query(
    `SELECT id, editable_config, created_by, reason, restored_from_snapshot_id, created_at
     FROM config_import_snapshots
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

module.exports = {
  MAX_CONFIG_IMPORT_SNAPSHOTS,
  createSnapshot,
  getSnapshot,
  listSnapshots,
  pruneOldSnapshots,
};
