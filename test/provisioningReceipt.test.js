const test = require("node:test");
const assert = require("node:assert/strict");
const { CURRENT_PROVISIONING_RECEIPT_VERSION, requireSupportedProvisioningReceipt, secretFreeR2ReceiptState } = require("../src/provisioning/provisioningReceipt");
const { buildProvisioningReceipt } = require("../scripts/provisionClient");

test("receipt compatibility accepts v3 and v4 and rejects future versions", () => {
  assert.equal(requireSupportedProvisioningReceipt({ version: 3 }), 3);
  assert.equal(requireSupportedProvisioningReceipt({ version: 4 }), 4);
  assert.throws(() => requireSupportedProvisioningReceipt({ version: 5 }), /Unsupported provisioning receipt version 5/);
});

test("R2 receipt metadata uses an explicit allowlist", () => {
  const safe = secretFreeR2ReceiptState({
    mode: "required",
    enabled: true,
    provisioned: true,
    bucketName: "da-chatbot-acme-media",
    tokenId: "token-id",
    tokenName: "da-chatbot-acme-r2",
    locationHint: "apac",
    jurisdiction: "default",
    accessKeyId: "not-for-receipt",
    secretAccessKey: "not-for-receipt",
  });
  assert.equal(safe.bucketName, "da-chatbot-acme-media");
  assert.equal(Object.hasOwn(safe, "accessKeyId"), false);
  assert.equal(Object.hasOwn(safe, "secretAccessKey"), false);
});

test("provisioning receipt cannot persist accidental R2 credential fields", () => {
  const receipt = buildProvisioningReceipt({
    clientSlug: "acme",
    industry: "generic",
    requiredChannels: ["whatsapp"],
    profileContract: { envKey: "INITIAL_BUSINESS_TYPE", value: "generic" },
    neon: { projectId: "neon-1" },
    r2: {
      mode: "required",
      enabled: true,
      provisioned: true,
      bucketName: "da-chatbot-acme-media",
      tokenId: "token-id",
      tokenName: "da-chatbot-acme-r2",
      locationHint: "apac",
      jurisdiction: "default",
      secretAccessKey: "do-not-write",
      accessKeyId: "do-not-write",
    },
    render: { serviceId: "srv-1" },
    runtimeFinalization: null,
    opsEnrollment: null,
    readiness: null,
  });
  assert.equal(receipt.version, CURRENT_PROVISIONING_RECEIPT_VERSION);
  assert.equal(Object.hasOwn(receipt.r2, "secretAccessKey"), false);
  assert.equal(Object.hasOwn(receipt.r2, "accessKeyId"), false);
});
