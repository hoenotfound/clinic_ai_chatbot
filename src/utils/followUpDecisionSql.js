// Some existing staff handoffs are stored as skip decisions. They must remain
// terminal when staff return a conversation to AI. Ordinary AI skips advance
// only that step, but explicit requests not to be contacted remain terminal.
function terminalFollowUpDecisionSql(alias = "decision") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new TypeError("Invalid follow-up decision alias.");
  }
  return `(
    ${alias}.action = 'human_review'
    OR (
      ${alias}.action = 'skip'
      AND (
        ${alias}.reason ILIKE 'Cancelled because%'
        OR ${alias}.reason ~* '(asked to stop messaging|stop sending messages|no more messages|do not contact|do not message|not to (contact|message)|opt[ -]?out|unsubscribe|不要再发|停止联系|不要联系)'
      )
    )
  )`;
}

module.exports = { terminalFollowUpDecisionSql };
