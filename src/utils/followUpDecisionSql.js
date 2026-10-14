// Older 'skip' rows represented a cancelled conversation sequence, not a
// skipped individual reminder. Preserve their terminal meaning during rollout.
// Only new decisions deliberately prefixed as step skips can advance FU2/FU3.
const STEP_SKIP_PREFIX = "step_skip:";
const SEQUENCE_STOP_PREFIX = "sequence_stop:";

function validAlias(alias) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new TypeError("Invalid follow-up decision alias.");
  }
  return alias;
}

function continuableFollowUpSkipSql(alias = "decision") {
  const d = validAlias(alias);
  return `(${d}.action = 'skip' AND ${d}.reason LIKE 'step_skip:%')`;
}

function terminalFollowUpDecisionSql(alias = "decision") {
  const d = validAlias(alias);
  return `(
    ${d}.action = 'human_review'
    OR (${d}.action = 'skip' AND (
      ${d}.reason IS NULL OR ${d}.reason NOT LIKE 'step_skip:%'
    ))
  )`;
}

// Keep the persisted schema backward-compatible ('skip' / 'human_review'),
// but store the model's explicit distinction with a durable typed prefix.
function normalizeFollowUpDecision({ action, reason }) {
  const text = String(reason || "").trim();
  if (action === "skip") {
    return { action: "skip", reason: STEP_SKIP_PREFIX + " " + text };
  }
  if (action === "stop_sequence") {
    return { action: "skip", reason: SEQUENCE_STOP_PREFIX + " " + text };
  }
  return { action, reason: text };
}

module.exports = {
  STEP_SKIP_PREFIX,
  SEQUENCE_STOP_PREFIX,
  continuableFollowUpSkipSql,
  terminalFollowUpDecisionSql,
  normalizeFollowUpDecision,
};
