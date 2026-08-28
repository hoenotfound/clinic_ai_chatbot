const clinicConfig = require("../config/clinicConfig");
const leadScoringRepo = require("../db/leadScoringRepo");
const { scoreLeadConversation } = require("./leadScoringAiService");

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

function createLeadScoringRunner({
  repository = leadScoringRepo,
  scoreConversation = scoreLeadConversation,
  settingsGetter = getActiveSettings,
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

          await repository.completeScore({
            scoreId: claim.id,
            leadId: candidate.lead_id,
            throughMessageId: candidate.through_message_id,
            triggerType: candidate.trigger_type,
            score,
          });
        } catch (err) {
          await repository.markScoreFailed(claim.id, err);
          console.error(
            `Lead scoring failed for lead ${candidate.lead_id}:`,
            err
          );
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
  createLeadScoringRunner,
  getActiveSettings,
  runLeadScoring,
  startLeadScoring,
  trimTranscript,
};
