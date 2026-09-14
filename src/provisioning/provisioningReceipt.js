const SUPPORTED_PROVISIONING_RECEIPT_VERSIONS = Object.freeze([3, 4]);
const CURRENT_PROVISIONING_RECEIPT_VERSION = 4;

function requireSupportedProvisioningReceipt(receipt) {
  const version = Number(receipt?.version);
  if (!SUPPORTED_PROVISIONING_RECEIPT_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported provisioning receipt version ${Number.isFinite(version) ? version : "unknown"}. Supported versions: ${SUPPORTED_PROVISIONING_RECEIPT_VERSIONS.join(", ")}.`
    );
  }
  return version;
}

function secretFreeR2ReceiptState(r2) {
  if (!r2) return null;
  return {
    mode: r2.mode || null,
    enabled: r2.enabled === true,
    provisioned: r2.provisioned === true,
    bucketName: r2.bucketName || null,
    tokenId: r2.tokenId || null,
    tokenName: r2.tokenName || null,
    locationHint: r2.locationHint || null,
    jurisdiction: r2.jurisdiction || null,
  };
}

module.exports = {
  CURRENT_PROVISIONING_RECEIPT_VERSION,
  SUPPORTED_PROVISIONING_RECEIPT_VERSIONS,
  requireSupportedProvisioningReceipt,
  secretFreeR2ReceiptState,
};
