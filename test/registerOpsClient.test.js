const test = require("node:test");
const assert = require("node:assert/strict");

const {
  defaultTokenEnvKey,
  parseArgs,
  registerRecord,
  registryRecordFromReceipt,
} = require("../scripts/registerOpsClient");

function receipt(version = 3) {
  return {
    version,
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
    secrets: { OPS_READINESS_TOKEN: "must-not-leak" },
  };
}

test("provisioning v3 receipt becomes a secret-free registry record", () => {
  const record = registryRecordFromReceipt(receipt(3));

  assert.equal(record.clientSlug, "beleco-clinic");
  assert.equal(record.tokenEnvKey, "OPS_CLIENT_TOKEN_BELECO_CLINIC");
  assert.equal(Object.hasOwn(record, "token"), false);
  assert.doesNotMatch(JSON.stringify(record), /must-not-leak/);
  assert.deepEqual(record.purchasedChannels, ["whatsapp", "instagram"]);
});

test("provisioning v4 receipt remains compatible with Ops registration", () => {
  const input = receipt(4);
  input.r2 = {
    enabled: true,
    bucketName: "da-chatbot-beleco-media",
    tokenId: "token-id",
  };
  const record = registryRecordFromReceipt(input);
  assert.equal(record.clientSlug, "beleco-clinic");
  assert.equal(record.render.serviceId, "srv-123");
  assert.equal(Object.hasOwn(record, "r2"), false);
});

test("unsupported provisioning receipt versions fail closed", () => {
  assert.throws(
    () => registryRecordFromReceipt(receipt(5)),
    /Unsupported provisioning receipt version 5/
  );
});

test("token env names are deterministic and contain no client secret", () => {
  assert.equal(defaultTokenEnvKey("abc clinic"), "OPS_CLIENT_TOKEN_ABC_CLINIC");
});

test("--upsert is an explicit boolean flag", () => {
  assert.deepEqual(parseArgs(["--receipt", "client.json", "--upsert"]), {
    receiptPath: "client.json",
    upsert: true,
  });
});

test("new registration uses insert and does not silently overwrite duplicate slugs", async () => {
  let upsertCalled = false;
  const duplicate = Object.assign(new Error("duplicate"), { code: "23505" });
  const repo = {
    insertClient: async () => { throw duplicate; },
    upsertClient: async () => { upsertCalled = true; },
  };

  await assert.rejects(
    registerRecord(repo, { clientSlug: "acme" }),
    (error) => error.code === "OPS_CLIENT_ALREADY_EXISTS" && /--upsert/.test(error.message),
  );
  assert.equal(upsertCalled, false);
});

test("duplicate token environment key gets a specific registration error", async () => {
  const duplicate = Object.assign(new Error("duplicate token env"), {
    code: "23505",
    constraint: "idx_ops_clients_token_env_key_unique",
  });
  const repo = {
    insertClient: async () => { throw duplicate; },
    upsertClient: async () => assert.fail("upsert should not be called"),
  };

  await assert.rejects(
    registerRecord(repo, {
      clientSlug: "beta",
      tokenEnvKey: "OPS_CLIENT_TOKEN_SHARED",
    }),
    (error) => error.code === "OPS_TOKEN_ENV_ALREADY_EXISTS" && /unique per-client/i.test(error.message),
  );
});

test("upsert also normalizes a duplicate token environment key conflict", async () => {
  const duplicate = Object.assign(new Error("duplicate token env"), {
    code: "23505",
    constraint: "idx_ops_clients_token_env_key_unique",
  });
  const repo = {
    insertClient: async () => assert.fail("insert should not be called"),
    upsertClient: async () => { throw duplicate; },
  };

  await assert.rejects(
    registerRecord(repo, {
      clientSlug: "beta",
      tokenEnvKey: "OPS_CLIENT_TOKEN_SHARED",
    }, { upsert: true }),
    (error) => error.code === "OPS_TOKEN_ENV_ALREADY_EXISTS" && /unique per-client/i.test(error.message),
  );
});

test("explicit upsert uses the update path", async () => {
  const repo = {
    insertClient: async () => assert.fail("insert should not be called"),
    upsertClient: async (record) => ({ ...record, displayName: "Updated" }),
  };
  const saved = await registerRecord(repo, { clientSlug: "acme" }, { upsert: true });
  assert.equal(saved.displayName, "Updated");
});
