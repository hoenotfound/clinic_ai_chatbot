const crypto = require("crypto");
const repo = require("../db/customerDataLifecycleRepo");
const mediaStorage = require("./mediaStorageService");
const realtimeEvents = require("../utils/realtimeEvents");

const MEDIA_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PURGE_JOB_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_BATCH_SIZE = 25;
const CLEANUP_BATCH_SIZE = 20;

function retentionDaysFromEnv(env = process.env) {
  const raw = String(env.CUSTOMER_DATA_RETENTION_DAYS || "").trim();
  if (!raw || raw === "0") return 0;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 30 || days > 3650) {
    throw new Error(
      "CUSTOMER_DATA_RETENTION_DAYS must be 0 (disabled) or an integer from 30 to 3650."
    );
  }
  return days;
}

async function processClaimedPurgeJob(job, {
  repository = repo,
  storage = mediaStorage,
} = {}) {
  if (!job) return null;
  try {
    const deletedMediaObjects = await storage.deleteCustomerMediaObjects({
      mediaKeys: job.media_keys,
      mediaPrefixes: job.media_prefixes,
    });
    const completed = await repository.markPurgeJobCompleted({
      jobId: job.id,
      leaseToken: job.lease_token,
    });
    return {
      status: "completed",
      job: completed || job,
      deletedMediaObjects,
    };
  } catch (err) {
    await repository.markPurgeJobFailed({
      jobId: job.id,
      leaseToken: job.lease_token,
      error: err,
      attempts: job.attempts,
    }).catch((markErr) => {
      console.error(
        `Failed to persist customer purge cleanup failure for job ${job.id}:`,
        markErr
      );
    });
    throw err;
  }
}

async function processPurgeJobById(jobId, dependencies = {}) {
  const repository = dependencies.repository || repo;
  const leaseToken = crypto.randomUUID();
  const job = await repository.claimPurgeJob({ jobId, leaseToken });
  if (!job) return null;
  return processClaimedPurgeJob(job, {
    ...dependencies,
    repository,
  });
}

async function purgeCustomerData({
  contactId,
  requestedBy = null,
  reason = "manual",
  retentionCutoff = null,
} = {}, dependencies = {}) {
  const repository = dependencies.repository || repo;
  const storage = dependencies.storage || mediaStorage;
  const events = dependencies.events || realtimeEvents;
  const mediaPrefixes = storage.customerMediaPrefixes(contactId);

  const result = await repository.purgeContactData({
    contactId,
    reason,
    requestedBy,
    mediaPrefixes,
    retentionCutoff,
  });
  if (result.status !== "purged") return result;

  events.publish("pipeline_changed", {
    contactId: Number(contactId),
    reason: "customer_deleted",
  });
  events.publish("conversation_changed", {
    contactId: Number(contactId),
    reason: "customer_deleted",
  });

  try {
    const cleanup = await processPurgeJobById(result.job.id, {
      ...dependencies,
      repository,
      storage,
    });
    return {
      ...result,
      mediaCleanupPending: cleanup?.status !== "completed",
      deletedMediaObjects: cleanup?.deletedMediaObjects || 0,
    };
  } catch (err) {
    console.error(
      `Customer ${contactId} database purge committed but media cleanup will retry:`,
      err
    );
    return {
      ...result,
      mediaCleanupPending: true,
      deletedMediaObjects: 0,
    };
  }
}

async function runMediaCleanupSweep({
  limit = CLEANUP_BATCH_SIZE,
  repository = repo,
  storage = mediaStorage,
} = {}) {
  let processed = 0;
  let completed = 0;
  let failed = 0;

  while (processed < limit) {
    const job = await repository.claimPurgeJob({
      leaseToken: crypto.randomUUID(),
    });
    if (!job) break;
    processed += 1;
    try {
      await processClaimedPurgeJob(job, { repository, storage });
      completed += 1;
    } catch (err) {
      failed += 1;
      console.error(`Customer purge media cleanup job ${job.id} failed:`, err);
    }
  }

  return { processed, completed, failed };
}

async function runRetentionSweep({
  env = process.env,
  now = new Date(),
  limit = RETENTION_BATCH_SIZE,
  repository = repo,
  storage = mediaStorage,
} = {}) {
  const days = retentionDaysFromEnv(env);
  if (days === 0) {
    return { enabled: false, days: 0, candidates: 0, purged: 0, skipped: 0 };
  }

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const candidates = await repository.listRetentionCandidates({ cutoff, limit });
  let purged = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    try {
      const result = await purgeCustomerData({
        contactId: candidate.id,
        requestedBy: "Retention policy",
        reason: "retention",
        retentionCutoff: cutoff,
      }, { repository, storage });
      if (result.status === "purged") purged += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.error(
        `Failed to apply customer retention policy to contact ${candidate.id}:`,
        err
      );
    }
  }

  return {
    enabled: true,
    days,
    cutoff: cutoff.toISOString(),
    candidates: candidates.length,
    purged,
    skipped,
  };
}

function startCustomerDataLifecycle({
  env = process.env,
  setIntervalFn = setInterval,
  repository = repo,
  storage = mediaStorage,
} = {}) {
  const runCleanup = () => {
    runMediaCleanupSweep({ repository, storage }).catch((err) => {
      console.error("Customer purge media-cleanup sweep failed:", err);
    });
  };
  const runRetention = () => {
    runRetentionSweep({ env, repository, storage })
      .then((result) => {
        if (result.enabled && (result.purged > 0 || result.skipped > 0)) {
          console.log(
            `Customer retention sweep: purged=${result.purged}, skipped=${result.skipped}, retention=${result.days}d.`
          );
        }
      })
      .catch((err) => {
        console.error("Customer retention sweep failed:", err);
      });
  };
  const pruneJobs = () => {
    repository.pruneCompletedPurgeJobs().catch((err) => {
      console.error("Failed to prune completed customer purge jobs:", err);
    });
  };

  // Do not run R2 cleanup or retention immediately during deploy/startup.
  // PR #236 deliberately keeps the hot-deploy window free for live customer
  // media traffic. Manual customer deletion still attempts its own cleanup
  // immediately; durable recovery begins on the normal cleanup interval.
  const cleanupTimer = setIntervalFn(runCleanup, MEDIA_CLEANUP_INTERVAL_MS);
  cleanupTimer?.unref?.();
  const retentionTimer = setIntervalFn(runRetention, RETENTION_SWEEP_INTERVAL_MS);
  retentionTimer?.unref?.();
  const pruneTimer = setIntervalFn(pruneJobs, PURGE_JOB_PRUNE_INTERVAL_MS);
  pruneTimer?.unref?.();

  return { cleanupTimer, retentionTimer, pruneTimer };
}

module.exports = {
  CLEANUP_BATCH_SIZE,
  MEDIA_CLEANUP_INTERVAL_MS,
  PURGE_JOB_PRUNE_INTERVAL_MS,
  RETENTION_BATCH_SIZE,
  RETENTION_SWEEP_INTERVAL_MS,
  processClaimedPurgeJob,
  processPurgeJobById,
  purgeCustomerData,
  retentionDaysFromEnv,
  runMediaCleanupSweep,
  runRetentionSweep,
  startCustomerDataLifecycle,
};
