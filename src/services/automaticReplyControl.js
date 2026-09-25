const AUTOMATED_REPLIES_ENV_KEY = "AUTOMATED_REPLIES_ENABLED";

/**
 * Global customer-facing automation switch.
 *
 * Backward compatibility:
 * - Existing deployments that do not have the variable keep their current
 *   behaviour and remain enabled.
 * - Newly provisioned clients explicitly receive "false" from the provisioner
 *   and stay silent until an operator enables them.
 *
 * When the variable is present, only the literal value "true"
 * (case-insensitive, surrounding whitespace ignored) enables automation.
 * Empty, false, malformed or unexpected values fail closed.
 */
function automatedRepliesEnabled(env = process.env) {
  if (!env || !Object.prototype.hasOwnProperty.call(env, AUTOMATED_REPLIES_ENV_KEY)) {
    return true;
  }

  return String(env[AUTOMATED_REPLIES_ENV_KEY] ?? "")
    .trim()
    .toLowerCase() === "true";
}

module.exports = {
  AUTOMATED_REPLIES_ENV_KEY,
  automatedRepliesEnabled,
};
