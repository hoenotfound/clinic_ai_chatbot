const { pool } = require("./db");
const realtimeEvents = require("../utils/realtimeEvents");

async function getUnassignedCounts(queryable = pool) {
  const result = await queryable.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE owner_username IS NULL
       )::int AS open_unassigned_count,
       COUNT(*) FILTER (
         WHERE owner_username IS NULL
           AND owner_assignment_source IS NULL
       )::int AS recoverable_unassigned_count,
       COUNT(*) FILTER (
         WHERE owner_username IS NULL
           AND owner_assignment_source = 'manual'
       )::int AS manual_unassigned_count
     FROM leads
     WHERE is_closed = false`
  );
  const row = result.rows[0] || {};
  return {
    openUnassignedCount: Number(row.open_unassigned_count) || 0,
    recoverableUnassignedCount: Number(row.recoverable_unassigned_count) || 0,
    manualUnassignedCount: Number(row.manual_unassigned_count) || 0,
  };
}

async function recoverUnassignedOpenLeads(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const result = await pool.query(
    "SELECT recover_unassigned_open_leads($1) AS recovered_count",
    [safeLimit]
  );
  const recoveredCount = Number(result.rows[0]?.recovered_count) || 0;
  if (recoveredCount > 0) {
    realtimeEvents.publish("pipeline_changed", { leadId: null });
    realtimeEvents.publish("conversation_changed", {
      reason: "lead_assignment_recovered",
    });
  }
  return {
    recoveredCount,
    ...(await getUnassignedCounts()),
  };
}

module.exports = {
  getUnassignedCounts,
  recoverUnassignedOpenLeads,
};
