const { pool } = require("./db");

function normalizeJobType(jobType) {
  return jobType === "meta_resolution" ? "meta_resolution" : "message";
}

function normalizeChannel(channel) {
  return ["whatsapp", "facebook", "instagram"].includes(channel) ? channel : null;
}

async function recordFailure(job, { jobType = "message", at = new Date() } = {}, queryable = pool) {
  if (!job?.id) return;
  const channel = normalizeChannel(job.channel);
  if (!channel) return;
  await queryable.query(
    `INSERT INTO inbound_failure_events (job_type, job_id, channel, failed_at)
     VALUES ($1, $2, $3, $4)`,
    [normalizeJobType(jobType), job.id, channel, at]
  );
}

async function recordRestartRecoveries(
  jobs,
  { jobType = "message", at = new Date() } = {},
  queryable = pool
) {
  const rows = (jobs || [])
    .filter((job) => job?.id && normalizeChannel(job.channel))
    .map((job) => [normalizeJobType(jobType), job.id, normalizeChannel(job.channel), at]);
  if (!rows.length) return 0;

  for (const row of rows) {
    await queryable.query(
      `INSERT INTO inbound_recovery_events (job_type, job_id, channel, recovered_at)
       VALUES ($1, $2, $3, $4)`,
      row
    );
  }
  return rows.length;
}

module.exports = {
  recordFailure,
  recordRestartRecoveries,
};
