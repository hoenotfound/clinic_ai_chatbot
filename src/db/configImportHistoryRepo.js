const { pool } = require("./db");

async function createSnapshot({
  editableConfig,
  createdBy,
  reason,
  restoredFromSnapshotId = null,
}) {
  const result = await pool.query(
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
  return result.rows[0];
}

async function listSnapshots(limit = 12) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 12));
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
  createSnapshot,
  getSnapshot,
  listSnapshots,
};
