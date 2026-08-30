const clinicConfig = require("../config/clinicConfig");
const leadScoringRepo = require("../db/leadScoringRepo");
const leadScoringFailureRecoveryRepo = require("../db/leadScoringFailureRecoveryRepo");
const { scoreLeadConversation } = require("./leadScoringAiService");
const telegramAlerts = require("./telegramAlertService");

const LEAD_SCORING_CHECK_INTERVAL_MS = 60 * 1000;
const LEAD_SCORING_BATCH_SIZE = 5;
const MAX_TRANSCRIPT_MESSAGES = 80;
const MAX_TRANSCRIPT_CHARS = 30_000;

function getActiveSettings() {
  const settings = clinicConfig.leadScoring;
  if (
    !settings?.enabled ||
    !Number.isInteger(settings.inactivityMinutes) ||
    settings.inactivityMinutes < 5 ||
    settings.inactivityMinutes > 30 ||
    !Number.isInteger(settings.maxConversationMinutes) ||
    settings.maxConversationMinutes < 30 ||
    settings.maxConversationMinutes > 120 ||
    !Number.isInteger(settings.maxMessages) ||
    settings.maxMessages < 20 ||
    settings.maxMessages > 80 ||
    typeof settings.activatedAt !== "string" ||
    Number.isNaN(Date.parse(settings.activatedAt))
  ) {
    return null;
  }

  return {
    inactivityMinutes: settings.inactivityMinutes,
    maxConversationMinutes: settings.maxConversationMinutes,
    maxMessages: settings.maxMessages,
    activatedAt: settings.activatedAt,
  };
}

// Keep the newest context if a long conversation exceeds the prompt budget.
// Messages remain in chronological order and are never cut in the middle.
function trimTranscript(messages) {
  const kept = [];
  let totalChars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const chars = String(message.content || "").length;
    if (kept.length > 0 && totalChars + chars > MAX_TRANSCRIPT_CHARS) break;
    kept.push(message);
    totalChars += chars;
  }
  return kept.reverse();
}

function buildScoringFailureFallback(failure = {}) {
  const attempts = Number(failure.attempts);
  return {
    alertType: "ai_scoring_failed",
    summaryUnavailable: true,
    attempts: Number.isInteger(attempts) && attempts > 0 ? attempts : leadScoringRepo.MAX_ATTEMPTS,
    summary: {},
  };
}

async function queueScoringFailureFallback({
  failure,
  queueConversationSummary,
}) {
  return queueConversationSummary({
    leadId: failure.lead_id,
    throughMessageId: failure.through_message_id,
    score: buildScoringFailureFallback(failure),
  });
}

function createLeadScoringRunner({
  repository = leadScoringRepo,
  scoreConversation = scoreLeadConversation,
  settingsGetter = getActiveSettings,
  queueConversationSummary = telegramAlerts.queueConversationSummary,
  flushConversationSummaries = telegramAlerts.flushConversationSummaries,
  recoverStaleTerminalFailures = repository === leadScoringRepo
    ? leadScoringFailureRecoveryRepo.recoverStaleTerminalProcessingFailures
    : null,
} = {}) {
  let sweepRunning = false;

  return async function runLeadScoring() {
    if (sweepRunning) return;

    const settings = settingsGetter();
    if (!settings) return;

    sweepRunning = true;
    try {
      const candidates = await repository.findCandidates({
        ...settings,
        limit: LEAD_SCORING_BATCH_SIZE,
      });

      // Process sequentially to keep model usage predictable on small hosts.
      for (const candidate of candidates) {
        const liveSettings = settingsGetter();
        if (!liveSettings || liveSettings.activatedAt !== settings.activatedAt) break;

        const claim = await repository.claimCandidate(candidate);
        if (!claim) continue;

        try {
          const transcript = trimTranscript(
            await repository.getTranscript(
              candidate.contact_id,
              candidate.started_message_id,
              candidate.journey_started_at,
              candidate.through_message_id,
              MAX_TRANSCRIPT_MESSAGES
            )
          );
          if (!transcript.some((message) => message.role === "user")) {
            throw new Error("No customer messages were available for lead scoring.");
          }

          const score = await scoreConversation({
            messages: transcript,
            lead: candidate,
          });

          // A pause or fresh activation while the AI call was running must
          // prevent the old result from changing a lead.
          const settingsAfterScore = settingsGetter();
          if (
            !settingsAfterScore ||
            settingsAfterScore.activatedAt !== settings.activatedAt
          ) {
            await repository.markScoreCancelled(claim.id);
            continue;
          }

          const completion = await repository.completeScore({
            scoreId: claim.id,
            leadId: candidate.lead_id,
            throughMessageId: candidate.through_message_id,
            triggerType: candidate.trigger_type,
            score,
          });

          if (completion?.status === "completed") {
            try {
              // Queue every completed score snapshot. The Telegram queue checks
              // the current latest message and the inactivity threshold before
              // sending, so a time/message ceiling score can safely wait until
              // the conversation actually ends without another AI call.
              await queueConversationSummary({
                leadId: candidate.lead_id,
                throughMessageId: candidate.through_message_id,
                score,
              });
            } catch (telegramQueueErr) {
              console.error(
                `Failed to queue Telegram summary for lead ${candidate.lead_id}:`,
                telegramQueueErr
              );
            }
          }
        } catch (err) {
          const failure = await repository.markScoreFailed(claim.id, err);
          console.error(
            `Lead scoring failed for lead ${candidate.lead_id}:`,
            err
          );

          // A permanently failed AI score must not make the lead disappear from
          // the sales group's Telegram workflow. Queue a durable manual-review
          // alert for the same transcript boundary. It uses the normal inactivity
          // and newer-customer-message checks, but deliberately contains no AI
          // summary or AI temperature assessment.
          if (failure?.terminal) {
            try {
              await queueScoringFailureFallback({
                failure,
                queueConversationSummary,
              });
            } catch (telegramQueueErr) {
              // The recovery sweep below retries terminal scoring failures that
              // still have no Telegram queue row, including after a process crash.
              console.error(
                `Failed to queue Telegram fallback for lead ${candidate.lead_id}:`,
                telegramQueueErr
              );
            }
          }
        }
      }

      // If Render died while the final scoring attempt was still marked
      // processing, convert it to failed only after the existing stale timeout.
      // Any late AI completion then sees a non-processing score and is ignored.
      if (typeof recoverStaleTerminalFailures === "function") {
        try {
          await recoverStaleTerminalFailures();
        } catch (staleRecoveryErr) {
          console.error(
            "Failed to recover stale terminal lead-scoring attempts:",
            staleRecoveryErr
          );
        }
      }

      // Recover any terminal scoring failure that was committed before its
      // Telegram fallback could be queued (for example a Render restart between
      // those two operations). This also picks up eligible historical terminal
      // failures that pre-date the fallback behavior. The Telegram queue keeps
      // snapshot ordering monotonic, so an old recovery cannot replace a newer
      // queued summary.
      if (typeof repository.findTerminalFailuresNeedingAlert === "function") {
        try {
          const failures = await repository.findTerminalFailuresNeedingAlert({
            limit: LEAD_SCORING_BATCH_SIZE,
          });
          for (const failure of failures) {
            try {
              await queueScoringFailureFallback({
                failure,
                queueConversationSummary,
              });
            } catch (telegramQueueErr) {
              console.error(
                `Failed to recover Telegram fallback for lead ${failure.lead_id}:`,
                telegramQueueErr
              );
            }
          }
        } catch (fallbackRecoveryErr) {
          console.error(
            "Failed to recover terminal lead-scoring Telegram fallbacks:",
            fallbackRecoveryErr
          );
        }
      }

      // This runs even when there were no new scoring candidates. That is
      // important for a conversation that hit a time/message ceiling while
      // still active and only became inactive several minutes later.
      const liveSettings = settingsGetter();
      if (liveSettings?.activatedAt === settings.activatedAt) {
        try {
          await flushConversationSummaries({
            inactivityMinutes: liveSettings.inactivityMinutes,
          });
        } catch (telegramFlushErr) {
          console.error("Telegram summary sweep failed:", telegramFlushErr);
        }
      }
    } catch (err) {
      console.error("Lead scoring sweep failed:", err);
    } finally {
      sweepRunning = false;
    }
  };
}

const runLeadScoring = createLeadScoringRunner();

function startLeadScoring() {
  runLeadScoring();
  const timer = setInterval(runLeadScoring, LEAD_SCORING_CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

module.exports = {
  LEAD_SCORING_BATCH_SIZE,
  LEAD_SCORING_CHECK_INTERVAL_MS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  buildScoringFailureFallback,
  createLeadScoringRunner,
  getActiveSettings,
  runLeadScoring,
  startLeadScoring,
  trimTranscript,
};
