const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  bucketResourceId,
  createCloudflareR2Client,
} = require("../src/provisioning/r2Provisioning");

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload == null ? "" : JSON.stringify(payload);
    },
  };
}

function scopedToken({ accountId, bucketName, tokenName, tokenId, permissionId }) {
  return {
    id: tokenId,
    name: tokenName,
    status: "active",
    policies: [{
      effect: "allow",
      resources: { [bucketResourceId(accountId, bucketName, "default")]: "*" },
      permission_groups: [{
        id: permissionId,
        name: "Workers R2 Storage Bucket Item Write",
      }],
    }],
  };
}

test("R2 recovery finds the deterministic active token, verifies exact bucket scope, then rolls its secret", async () => {
  const accountId = "a".repeat(32);
  const bucketName = "da-chatbot-acme-media";
  const tokenName = "da-chatbot-acme-r2";
  const tokenId = "b".repeat(32);
  const permissionId = "permission-r2-write";
  const rolledValue = "cfat_recovered-secret-value-that-is-long-enough";
  let createTokenCalls = 0;
  let rollCalls = 0;

  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId,
    fetchImpl: async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/tokens/permission_groups")) {
        return response({
          success: true,
          result: [{
            id: permissionId,
            name: "Workers R2 Storage Bucket Item Write",
            scopes: ["com.cloudflare.edge.r2.bucket"],
          }],
        });
      }
      if (parsed.pathname.endsWith("/tokens") && options.method === "GET") {
        return response({
          success: true,
          result: [scopedToken({ accountId, bucketName, tokenName, tokenId, permissionId })],
          result_info: { page: 1, per_page: 50, total_count: 1 },
        });
      }
      if (parsed.pathname.endsWith(`/tokens/${tokenId}/value`)) {
        rollCalls += 1;
        assert.equal(options.method, "PUT");
        return response({ success: true, result: rolledValue });
      }
      if (parsed.pathname.endsWith("/tokens") && options.method === "POST") {
        createTokenCalls += 1;
      }
      throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}`);
    },
  });

  const recovered = await client.recoverBucketCredentials({ bucketName, tokenName });
  assert.equal(recovered.tokenId, tokenId);
  assert.equal(recovered.accessKeyId, tokenId);
  assert.equal(recovered.secretAccessKey, crypto.createHash("sha256").update(rolledValue).digest("hex"));
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.created, false);
  assert.equal(rollCalls, 1);
  assert.equal(createTokenCalls, 0);
});

test("R2 recovery refuses to roll a same-name token whose policy is broader than the expected bucket", async () => {
  const accountId = "a".repeat(32);
  const bucketName = "da-chatbot-acme-media";
  const tokenName = "da-chatbot-acme-r2";
  const tokenId = "c".repeat(32);
  const permissionId = "permission-r2-write";
  let rollCalls = 0;

  const badToken = scopedToken({ accountId, bucketName, tokenName, tokenId, permissionId });
  badToken.policies[0].resources["com.cloudflare.edge.r2.bucket.extra_default_other-bucket"] = "*";

  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId,
    fetchImpl: async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/tokens/permission_groups")) {
        return response({
          success: true,
          result: [{ id: permissionId, name: "Workers R2 Storage Bucket Item Write", scopes: ["com.cloudflare.edge.r2.bucket"] }],
        });
      }
      if (parsed.pathname.endsWith("/tokens")) {
        return response({
          success: true,
          result: [badToken],
          result_info: { page: 1, per_page: 50, total_count: 1 },
        });
      }
      if (parsed.pathname.endsWith(`/tokens/${tokenId}/value`)) {
        rollCalls += 1;
        return response({ success: true, result: "should-not-roll" });
      }
      throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}`);
    },
  });

  await assert.rejects(
    client.recoverBucketCredentials({ bucketName, tokenName }),
    (err) => err.code === "R2_RECOVERY_TOKEN_SCOPE_MISMATCH"
  );
  assert.equal(rollCalls, 0);
});

test("R2 recovery creates a new bucket-scoped token only when no same-name token exists", async () => {
  const accountId = "a".repeat(32);
  const bucketName = "da-chatbot-acme-media";
  const tokenName = "da-chatbot-acme-r2";
  const tokenId = "d".repeat(32);
  const permissionId = "permission-r2-write";
  const rawValue = "cfat_new-recovery-value-that-is-long-enough";
  let createTokenCalls = 0;

  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId,
    fetchImpl: async (url, options) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/tokens/permission_groups")) {
        return response({
          success: true,
          result: [{ id: permissionId, name: "Workers R2 Storage Bucket Item Write", scopes: ["com.cloudflare.edge.r2.bucket"] }],
        });
      }
      if (parsed.pathname.endsWith("/tokens") && options.method === "GET") {
        return response({
          success: true,
          result: [],
          result_info: { page: 1, per_page: 50, total_count: 0 },
        });
      }
      if (parsed.pathname.endsWith("/tokens") && options.method === "POST") {
        createTokenCalls += 1;
        const body = JSON.parse(options.body);
        assert.equal(body.name, tokenName);
        return response({ success: true, result: { id: tokenId, name: tokenName, value: rawValue } });
      }
      throw new Error(`Unexpected request: ${options.method} ${parsed.pathname}`);
    },
  });

  const recovered = await client.recoverBucketCredentials({ bucketName, tokenName });
  assert.equal(recovered.created, true);
  assert.equal(recovered.recovered, false);
  assert.equal(recovered.tokenId, tokenId);
  assert.equal(createTokenCalls, 1);
});
