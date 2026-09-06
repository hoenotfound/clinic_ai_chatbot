const inboundProcessingRepo = require("../db/inboundProcessingRepo");
const contactsRepo = require("../db/contactsRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { createAdaptiveWorkerTimer } = require("../utils/adaptiveWorkerTimer");
const metaMessaging = require("./metaMessagingService");
const {
  resumeIncomingProcessingJob,
  storeIncomingMessage,
} = require("./inboundMessageClaimService");
const { enqueueReplyConversation } = require("../utils/conversationQueue");

// Fast retry remains available while there is actual failed/recoverable work.
const RECOVERY_SWEEP_INTERVAL_MS = 10 * 1000;
// When completely idle, a very slow safety sweep protects against an unknown
// edge case without preventing Neon from scaling to zero.
const IDLE_RECOVERY_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Customer processing can legitimately include media download/transcription,
// a bounded Gemini/Claude reply chain and an outbound Meta request. Give the
// live worker a generous lease so recovery never races a healthy slow request.
// A real restart releases the process immediately; waiting up to three minutes
// is preferable to producing a duplicate outbound response.
const STALE_PROCESSING_SECONDS = 3 * 60;
const STALE_RECHECK_GRACE_MS = 5 * 1000;
const RECOVERY_BATCH_SIZE = 25;
const MAX_PROCESSING_ATTEMPTS = 5;
const COMPLETED_RETENTION_HOURS = 24;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let recoverySweepRunning = false;
let lastPrunedAt = Date.now();
let recoveryTimer = null;

function wakeInboundProcessingRecovery(delayMs = 0) {
  return recoveryTimer?.wake(delayMs) || false;
}

async function claimLiveItem(item, repository = inboundProcessingRepo) {
  if (!item?.savedInbound?.id) return null;
  const job = await repository.claimPendingByMessageId(item.savedInbound.id);
  if (!job) return null;
  return {
    ...item,
    processingJobId: job.id,
  };
}

async function markBatchFailed(items, error, repository = inboundProcessingRepo) {
  const failures = [];
  for (const item of items || []) {
    if (!item?.processingJobId) continue;
    try {
      const failed = await repository.markFailed(item.processingJobId, error);
      if (failed) failures.push(failed);
    } catch (markErr) {
      console.error(
        `Failed to persist inbound processing failure for job ${item.processingJobId}:`,
        markErr
      );
    }
  }

  // Live webhook processing uses this same helper outside the recovery timer.
  // If a real attempt failed, request a fast retry instead of depending on an
  // always-on 10-second database poll.
  if (failures.length > 0 && repository === inboundProcessingRepo) {
    wakeInboundProcessingRecovery(RECOVERY_SWEEP_INTERVAL_MS);
  }
  return failures;
}

async function processClaimedBatch(
  items,
  batchProcessor,
  repository = inboundProcessingRepo
) {
  if (!items?.length) return;
  try {
    await batchProcessor(items);
    await Promise.all(
      items
        .filter((item) => item?.processingJobId)
        .map((item) => repository.markCompleted(item.processingJobId))
    );
  } catch (err) {
    err.inboundProcessingFailures = await markBatchFailed(items, err, repository);
    throw err;
  }
}

function groupJobsByContact(jobs) {
  const groups = new Map();
  for (const job of jobs || []) {
    const key = Number(job.contact_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Number(a.message_id) - Number(b.message_id));
  }
  return [...groups.values()];
}

/**
 * Recovered jobs must use the exact same slow-reply queue key as live webhook
 * traffic. Otherwise a recovered message and a brand-new message from the same
 * customer could generate/send replies concurrently after a restart.
 */
function replyQueueKeyForRecoveredItems(items) {
  const first = items?.[0] || {};
  const incoming = first.incoming || {};
  const channel = incoming.channel || "whatsapp";
  const from = String(incoming.from || "").trim();

  if (from) {
    return channel === "whatsapp" ? from : `${channel}:${from}`;
  }

  // Valid Meta/WhatsApp inbound payloads always contain `from`, but retaining a
  // stable contact-id fallback prevents unrelated recovered conversations from
  // collapsing onto a shared "unknown" queue if an old/corrupt payload lacks it.
  const contactId = first.contact?.id || first.savedInbound?.contact_id || "unknown";
  return `contact:${contactId}`;
}

async function flagTerminalFailure(
  job,
  contacts = contactsRepo,
  repository = inboundProcessingRepo
) {
  if (!job || Number(job.attempts) < MAX_PROCESSING_ATTEMPTS) return false;
  try {
    await contacts.setAttention(
      job.contact_id,
      true,
      "A customer message could not be processed after multiple automatic retries. Staff review is required."
    );
  } catch (err) {
    // Do not mark the job terminal until the staff-attention write succeeds.
    // That leaves it discoverable so a later sweep can try the handoff again.
    console.error(
      `Failed to flag terminal inbound-processing job ${job.id} for staff attention:`,
      err
    );
    return false;
  }

  try {
    await repository.markTerminal(job.id);
    return true;
  } catch (err) {
    // Staff has already been alerted, so the customer is safe. Leaving
    // terminal_at unset simply makes a later sweep retry this bookkeeping.
    console.error(
      `Failed to mark inbound-processing job ${job.id} terminal after staff handoff:`,
      err
    );
    return false;
  }
}

/**
 * Resolves pre-ACK durable Meta message_edit placeholders. The resolver only
 * needs to turn the opaque Meta message id into a normal durable customer
 * message; the ordinary inbound-processing recovery immediately below then
 * handles preparation/AI/outbound work in the same sweep.
 */
async function recoverMetaResolutionJobs({
  repository = inboundProcessingRepo,
  resolveJob = metaMessaging.resolveClaimedMessageEditJob,
  storeIncoming = storeIncomingMessage,
} = {}) {
  if (typeof repository.claimRecoverableMetaResolutions !== "function") return 0;

  const jobs = await repository.claimRecoverableMetaResolutions({
    limit: RECOVERY_BATCH_SIZE,
    staleAfterSeconds: STALE_PROCESSING_SECONDS,
    maxAttempts: MAX_PROCESSING_ATTEMPTS,
  });

  for (const job of jobs) {
    try {
      const incoming = await resolveJob(job);
      if (!incoming) {
        await repository.markMetaResolutionCompleted(job.id);
        continue;
      }

      // storeIncomingMessage atomically creates the ordinary customer message
      // + processing job and then completes this resolution row. If a standard
      // message webhook already created the same message, its dedupe path still
      // completes the resolution row without generating duplicate reply work.
      await storeIncoming(incoming);
    } catch (err) {
      console.error(`Failed to recover Meta message resolution job ${job.id}:`, err);
      const failed = await repository.markMetaResolutionFailed(job.id, err).catch(() => null);
      if (failed && Number(failed.attempts) >= MAX_PROCESSING_ATTEMPTS) {
        await repository.markMetaResolutionTerminal(job.id).catch((terminalErr) => {
          console.error(
            `Failed to mark exhausted Meta resolution job ${job.id} terminal:`,
            terminalErr
          );
        });
      }
    }
  }

  if (typeof repository.listExhaustedMetaResolutions !== "function") return jobs.length;
  const exhausted = await repository.listExhaustedMetaResolutions({
    limit: RECOVERY_BATCH_SIZE,
    staleAfterSeconds: STALE_PROCESSING_SECONDS,
    maxAttempts: MAX_PROCESSING_ATTEMPTS,
  });
  for (const job of exhausted) {
    console.error(
      `Meta message resolution job ${job.id} exhausted ${job.attempts} attempts; ` +
      `leaving the durable failure for diagnostics.`
    );
    await repository.markMetaResolutionTerminal(job.id).catch((err) => {
      console.error(`Failed to mark Meta resolution job ${job.id} terminal:`, err);
    });
  }
  return jobs.length + exhausted.length;
}

async function runInboundProcessingRecovery({
  repository = inboundProcessingRepo,
  resumeJob = resumeIncomingProcessingJob,
  processBatch,
  contacts = contactsRepo,
  resolveMetaJob = metaMessaging.resolveClaimedMessageEditJob,
  storeIncoming = storeIncomingMessage,
} = {}) {
  if (recoverySweepRunning) return { workCount: 0 };
  if (typeof processBatch !== "function") {
    throw new TypeError("runInboundProcessingRecovery requires processBatch.");
  }

  recoverySweepRunning = true;
  let workCount = 0;
  try {
    // Resolve opaque Instagram/Facebook message_edit notifications first. Any
    // customer messages created here are pending ordinary jobs and are picked
    // up by claimRecoverable immediately below, so restart recovery remains one
    // ordered pipeline rather than a second reply path.
    workCount += await recoverMetaResolutionJobs({
      repository,
      resolveJob: resolveMetaJob,
      storeIncoming,
    });

    const jobs = await repository.claimRecoverable({
      limit: RECOVERY_BATCH_SIZE,
      staleAfterSeconds: STALE_PROCESSING_SECONDS,
      maxAttempts: MAX_PROCESSING_ATTEMPTS,
    });
    workCount += jobs.length;

    for (const group of groupJobsByContact(jobs)) {
      const items = [];
      for (const job of group) {
        try {
          const item = await resumeJob(job);
          // Opt-outs deliberately complete their durable job during prepare and
          // return null because there must be no automated outbound response.
          if (item) items.push(item);
        } catch (err) {
          console.error(`Failed to restore inbound processing job ${job.id}:`, err);
          const failed = await repository.markFailed(job.id, err).catch(() => null);
          await flagTerminalFailure(failed || job, contacts, repository);
        }
      }

      if (!items.length) continue;
      try {
        // Messages from the same contact are replayed together in message-id
        // order. Use the same reply queue as live typing bursts so restart
        // recovery can never race a fresh message from this customer.
        await enqueueReplyConversation(
          replyQueueKeyForRecoveredItems(items),
          () => processClaimedBatch(items, processBatch, repository)
        );
      } catch (err) {
        console.error(
          `Recovered inbound batch for contact ${group[0]?.contact_id} failed:`,
          err
        );
        const failures = err.inboundProcessingFailures || group;
        for (const failed of failures) {
          await flagTerminalFailure(failed, contacts, repository);
        }
      }
    }

    // A process can die immediately after leasing the final allowed attempt.
    // Such a stale job is no longer retryable, so surface it to staff instead
    // of allowing it to disappear forever just because the crash happened at
    // the exact retry boundary.
    const exhaustedJobs = await repository.listExhausted({
      limit: RECOVERY_BATCH_SIZE,
      staleAfterSeconds: STALE_PROCESSING_SECONDS,
      maxAttempts: MAX_PROCESSING_ATTEMPTS,
    });
    workCount += exhaustedJobs.length;
    for (const job of exhaustedJobs) {
      await flagTerminalFailure(job, contacts, repository);
    }

    if (Date.now() - lastPrunedAt >= PRUNE_INTERVAL_MS) {
      lastPrunedAt = Date.now();
      await repository.pruneCompleted({
        olderThanHours: COMPLETED_RETENTION_HOURS,
      }).catch((err) => {
        console.warn("Failed to prune completed inbound-processing jobs:", err?.message || err);
      });
    }

    return { workCount };
  } catch (err) {
    console.error("Inbound processing recovery sweep failed:", err);
    throw err;
  } finally {
    recoverySweepRunning = false;
  }
}

function recoveryDelayForResult(result, { runCount }) {
  if (Number(result?.workCount) > 0) return RECOVERY_SWEEP_INTERVAL_MS;
  // A fresh processing lease from the previous Render instance may not be stale
  // during the first startup sweep. Recheck once just after the lease window,
  // then become truly idle.
  if (runCount === 1) {
    return STALE_PROCESSING_SECONDS * 1000 + STALE_RECHECK_GRACE_MS;
  }
  return IDLE_RECOVERY_SWEEP_INTERVAL_MS;
}

function startInboundProcessingRecovery({ processBatch } = {}) {
  if (typeof processBatch !== "function") {
    throw new TypeError("startInboundProcessingRecovery requires processBatch.");
  }
  if (recoveryTimer && !recoveryTimer.state().stopped) {
    return () => recoveryTimer.stop();
  }

  recoveryTimer = createAdaptiveWorkerTimer({
    run: () => runInboundProcessingRecovery({ processBatch }),
    delayForResult: recoveryDelayForResult,
    errorRetryDelayMs: RECOVERY_SWEEP_INTERVAL_MS,
    label: "Inbound processing recovery",
  });
  return recoveryTimer.start();
}

// The durability phase emits this only when a durable job genuinely needs a
// recovery safety check. Normal webhook replies still use the immediate live
// path and are never delayed by this timer.
realtimeEvents.subscribe("durable_inbound_pending", (payload) => {
  if (payload?.reason === "meta_resolution") {
    wakeInboundProcessingRecovery(0);
    return;
  }
  if (payload?.reason === "prepare_failed") {
    wakeInboundProcessingRecovery(RECOVERY_SWEEP_INTERVAL_MS);
    return;
  }
  wakeInboundProcessingRecovery(
    STALE_PROCESSING_SECONDS * 1000 + STALE_RECHECK_GRACE_MS
  );
});

module.exports = {
  COMPLETED_RETENTION_HOURS,
  IDLE_RECOVERY_SWEEP_INTERVAL_MS,
  MAX_PROCESSING_ATTEMPTS,
  RECOVERY_BATCH_SIZE,
  RECOVERY_SWEEP_INTERVAL_MS,
  STALE_PROCESSING_SECONDS,
  claimLiveItem,
  flagTerminalFailure,
  groupJobsByContact,
  markBatchFailed,
  processClaimedBatch,
  recoverMetaResolutionJobs,
  replyQueueKeyForRecoveredItems,
  runInboundProcessingRecovery,
  startInboundProcessingRecovery,
  wakeInboundProcessingRecovery,
};
