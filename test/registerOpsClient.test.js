const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultTokenEnvKey,
  registryRecordFromReceipt,
} = require("../scripts/registerOpsClient");

test("provisioning receipt becomes a secret-free registry record", () => {
  const record = registryRecordFromReceipt({
    version: 3,
    clientSlug: "beleco-clinic",
    industry: "aesthetic_clinic",
    requiredChannels: ["whatsapp", "instagram"],
    render: {
      url: "https://beleco.example.com",
      serviceId: "srv-123",
      serviceName: "da-chatbot-beleco",
      deployedCommitSha: "abc123",
    },
    neon: {
      projectId: "neon-123",
      projectName: "da-chatbot-beleco",
    },
  });

  assert.equal(record.clientSlug, "beleco-clinic");
  assert.equal(record.tokenEnvKey, "OPS_CLIENT_TOKEN_BELECO_CLINIC");
  assert.equal(Object.hasOwn(record, "token"), false);
  assert.deepEqual(record.purchasedChannels, ["whatsapp", "instagram"]);
});

test("token env names are deterministic and contain no client secret", () => {
  assert.equal(defaultTokenEnvKey("abc clinic"), "OPS_CLIENT_TOKEN_ABC_CLINIC");
});
