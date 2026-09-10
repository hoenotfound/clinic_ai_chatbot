function opsRegistryEnabled(env = process.env) {
  return String(env.OPS_REGISTRY_MODE || "").trim().toLowerCase() === "true";
}

function assertOpsRegistryMode(env = process.env) {
  if (!opsRegistryEnabled(env)) {
    const error = new Error("Ops Registry is disabled. Set OPS_REGISTRY_MODE=true for the control-plane deployment.");
    error.code = "OPS_REGISTRY_MODE_DISABLED";
    throw error;
  }
}

module.exports = {
  opsRegistryEnabled,
  assertOpsRegistryMode,
};
