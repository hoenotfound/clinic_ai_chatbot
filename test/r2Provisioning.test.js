const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  R2ProvisioningError,
  bucketResourceId,
  buildR2BucketName,
  buildR2ProvisioningPlan,
  createCloudflareR2Client,
  publicR2ProvisioningPlan,
  r2RuntimeEnv,
  requireR2ProvisioningConfig,
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

test("R2 provisioning auto mode preserves the existing manual path when Cloudflare is not configured", () => {
  const plan = buildR2ProvisioningPlan({ resourceName: "da-chatbot-acme" , env: {} });
  assert.equal(plan.mode, "auto");
  assert.equal(plan.enabled, false);
  assert.equal(plan.configured, false);
  assert.equal(plan.partiallyConfigured, false);
  assert.equal(plan.bucketName, "da-chatbot-acme-media");
  assert.deepEqual(plan.missing, [
    "PROVISIONING_CLOUDFLARE_ACCOUNT_ID",
    "PROVISIONING_CLOUDFLARE_API_TOKEN",
  ]);
  assert.doesNotThrow(() => requireR2ProvisioningConfig(plan));
});

test("R2 provisioning required mode fails before provider work when Cloudflare control config is missing", () => {
  const plan = buildR2ProvisioningPlan({
    resourceName: "da-chatbot-acme",
    mode: "required",
    env: {},
  });
  assert.equal(plan.enabled, true);
  assert.throws(
    () => requireR2ProvisioningConfig(plan),
    (err) => err instanceof R2ProvisioningError
      && err.code === "R2_PROVISIONING_CONFIG_MISSING"
      && err.stage === "validation"
  );
});

test("partial Cloudflare configuration fails closed even in auto mode", () => {
  const plan = buildR2ProvisioningPlan({
    resourceName: "da-chatbot-acme",
    env: { PROVISIONING_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) },
  });
  assert.equal(plan.partiallyConfigured, true);
  assert.throws(
    () => requireR2ProvisioningConfig(plan),
    (err) => err.code === "R2_PROVISIONING_CONFIG_MISSING"
  );
});

test("off mode deliberately ignores Cloudflare control-plane availability", () => {
  const plan = buildR2ProvisioningPlan({
    resourceName: "da-chatbot-acme",
    mode: "off",
    env: {
      PROVISIONING_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      PROVISIONING_CLOUDFLARE_API_TOKEN: "control-token",
    },
  });
  assert.equal(plan.enabled, false);
  assert.equal(plan.configured, true);
  assert.doesNotThrow(() => requireR2ProvisioningConfig(plan));
});

test("R2 bucket names stay valid and within Cloudflare's 63-character bucket limit", () => {
  const name = buildR2BucketName(`DA Chatbot ${"Very Long Client ".repeat(8)}`);
  assert.equal(name.length <= 63, true);
  assert.match(name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  assert.equal(name.endsWith("-media"), true);
});

test("public R2 plan never contains the Cloudflare control-plane token", () => {
  const secret = "cfat_super-secret-control-token";
  const plan = buildR2ProvisioningPlan({
    resourceName: "da-chatbot-acme",
    env: {
      PROVISIONING_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      PROVISIONING_CLOUDFLARE_API_TOKEN: secret,
    },
  });
  const publicPlan = publicR2ProvisioningPlan(plan);
  assert.equal(publicPlan.enabled, true);
  assert.equal(JSON.stringify(publicPlan).includes(secret), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicPlan, "accountId"), false);
});

test("Cloudflare client treats a missing exact bucket as collision-free", async () => {
  const calls = [];
  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId: "a".repeat(32),
    fetchImpl: async (url, options) => {
      calls.push([String(url), options]);
      return response({ success: false, errors: [{ message: "bucket not found" }] }, 404);
    },
  });

  assert.deepEqual(await client.findBucketsByExactName("da-chatbot-acme-media"), []);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /\/r2\/buckets\/da-chatbot-acme-media$/);
  assert.equal(calls[0][1].headers.Authorization, "Bearer control-token");
});

test("Cloudflare client creates a private Standard R2 bucket with the requested location hint", async () => {
  let requestBody = null;
  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId: "a".repeat(32),
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response({
        success: true,
        result: {
          name: requestBody.name,
          location: "apac",
          jurisdiction: "default",
          storage_class: "Standard",
        },
      });
    },
  });

  const bucket = await client.createBucket({
    name: "da-chatbot-acme-media",
    locationHint: "apac",
  });
  assert.equal(bucket.name, "da-chatbot-acme-media");
  assert.deepEqual(requestBody, {
    name: "da-chatbot-acme-media",
    locationHint: "apac",
    storageClass: "Standard",
  });
});

test("Cloudflare client creates bucket-scoped S3 credentials without exposing the raw API token value", async () => {
  const accountId = "a".repeat(32);
  const bucketName = "da-chatbot-acme-media";
  const rawTokenValue = "cfat_one-time-generated-value";
  const permissionId = "permission-write-id";
  const tokenId = "b".repeat(32);
  const calls = [];

  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId,
    fetchImpl: async (url, options) => {
      const parsed = new URL(String(url));
      calls.push([parsed.pathname, options]);
      if (parsed.pathname.endsWith("/tokens/permission_groups")) {
        assert.equal(parsed.searchParams.get("name"), "Workers R2 Storage Bucket Item Write");
        assert.equal(parsed.searchParams.get("scope"), "com.cloudflare.edge.r2.bucket");
        return response({
          success: true,
          result: [{
            id: permissionId,
            name: "Workers R2 Storage Bucket Item Write",
            scopes: ["com.cloudflare.edge.r2.bucket"],
          }],
        });
      }
      if (parsed.pathname.endsWith("/tokens")) {
        const body = JSON.parse(options.body);
        const resource = bucketResourceId(accountId, bucketName, "default");
        assert.equal(body.name, "da-chatbot-acme-r2");
        assert.deepEqual(body.policies, [{
          effect: "allow",
          resources: { [resource]: "*" },
          permission_groups: [{
            id: permissionId,
            name: "Workers R2 Storage Bucket Item Write",
          }],
        }]);
        return response({
          success: true,
          result: {
            id: tokenId,
            name: body.name,
            value: rawTokenValue,
          },
        });
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    },
  });

  const credentials = await client.createBucketCredentials({
    bucketName,
    tokenName: "da-chatbot-acme-r2",
  });
  const expectedSecret = crypto.createHash("sha256").update(rawTokenValue).digest("hex");
  assert.equal(credentials.accessKeyId, tokenId);
  assert.equal(credentials.secretAccessKey, expectedSecret);
  assert.equal(credentials.tokenId, tokenId);
  assert.equal(JSON.stringify(credentials).includes(rawTokenValue), false);
  assert.equal(calls.length, 2);

  const runtimeEnv = r2RuntimeEnv({ accountId, bucketName, credentials });
  assert.deepEqual(runtimeEnv, {
    R2_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: tokenId,
    R2_SECRET_ACCESS_KEY: expectedSecret,
    R2_BUCKET_NAME: bucketName,
  });
});

test("Cloudflare token roll can recover a lost one-time R2 secret without changing token scope", async () => {
  const tokenId = "c".repeat(32);
  const rolledValue = "cfat_rolled-secret";
  const client = createCloudflareR2Client({
    apiToken: "control-token",
    accountId: "a".repeat(32),
    fetchImpl: async (url, options) => {
      assert.match(String(url), new RegExp(`/tokens/${tokenId}/value$`));
      assert.equal(options.method, "PUT");
      return response({ success: true, result: rolledValue });
    },
  });

  const credentials = await client.rollBucketCredentials(tokenId);
  assert.equal(credentials.accessKeyId, tokenId);
  assert.equal(
    credentials.secretAccessKey,
    crypto.createHash("sha256").update(rolledValue).digest("hex")
  );
});
