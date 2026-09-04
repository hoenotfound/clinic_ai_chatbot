const inboundProcessingRepo = require("../db/inboundProcessingRepo");
const contactsRepo = require("../db/contactsRepo");
const {
  resumeIncomingProcessingJob,
} = require("./inboundMessageClaimService");
const { enqueueReplyConversation } = require("../utils/conversationQueue");

const RECOVERY_SWEEP_INTERVAL_MS = 10 * 1000;
// Customer processing can legitimately include media download/transcription,
// a bounded Gemini/Claude reply chain and an outbound Meta request. Give the
// live worker a generous lease so recovery never races a healthy slow request.
// A real restart releases the process immediately; waiting up to three minutes
// is preferable to producing a duplicate outbound response.
const STALE_PROCESSING_SECONDS = 3 * 60;
const RECOVERY_BATCH_SIZE = 25;
const MAX_PROCESSING_ATTEMPTS = 5;
const COMPLETED_RETENTION_HOURS = 24;
const PRUNE_EVERY_SWEEPS = 360; // about once per hour at the default cadence

let recoverySweepRunning = false;
let sweepCount = 0;

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

async function runInboundProcessingRecovery({
  repository = inboundProcessingRepo,
  resumeJob = resumeIncomingProcessingJob,
  processBatch,
  contacts = contactsRepo,
} = {}) {
  if (recoverySweepRunning) return;
  if (typeof processBatch !== "function") {
    throw new TypeError("runInboundProcessingRecovery requires processBatch.");
  }

  recoverySweepRunning = true;
  try {
    const jobs = await repository.claimRecoverable({
      limit: RECOVERY_BATCH_SIZE,
      staleAfterSeconds: STALE_PROCESSING_SECONDS,
      maxAttempts: MAX_PROCESSING_ATTEMPTS,
    });

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
    for (const job of exhaustedJobs) {
      await flagTerminalFailure(job, contacts, repository);
    }

    sweepCount += 1;
    if (sweepCount % PRUNE_EVERY_SWEEPS === 0) {
      await repository.pruneCompleted({
        olderThanHours: COMPLETED_RETENTION_HOURS,
      }).catch((err) => {
        console.warn("Failed to prune completed inbound-processing jobs:", err?.message || err);
      });
    }
  } catch (err) {
    console.error("Inbound processing recovery sweep failed:", err);
  } finally {
    recoverySweepRunning = false;
  }
}

function startInboundProcessingRecovery({ processBatch } = {}) {
  if (typeof processBatch !== "function") {
    throw new TypeError("startInboundProcessingRecovery requires processBatch.");
  }

  runInboundProcessingRecovery({ processBatch });
  const timer = setInterval(
    () => runInboundProcessingRecovery({ processBatch }),
    RECOVERY_SWEEP_INTERVAL_MS
  );
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  COMPLETED_RETENTION_HOURS,
  MAX_PROCESSING_ATTEMPTS,
  RECOVERY_BATCH_SIZE,
  RECOVERY_SWEEP_INTERVAL_MS,
  STALE_PROCESSING_SECONDS,
  claimLiveItem,
  flagTerminalFailure,
  groupJobsByContact,
  markBatchFailed,
  processClaimedBatch,
  replyQueueKeyForRecoveredItems,
  runInboundProcessingRecovery,
  startInboundProcessingRecovery,
};
