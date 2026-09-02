const test = require("node:test");
const assert = require("node:assert/strict");

const mediaStorage = require("../src/services/mediaStorageService");

test("R2 presigned GET URL matches AWS SigV4 for a fixed request", (t) => {
  const original = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  };
  t.after(() => {
    if (original.accountId === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = original.accountId;
    if (original.accessKeyId === undefined) delete process.env.R2_ACCESS_KEY_ID;
    else process.env.R2_ACCESS_KEY_ID = original.accessKeyId;
    if (original.secretAccessKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = original.secretAccessKey;
    if (original.bucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = original.bucket;
  });

  process.env.R2_ACCOUNT_ID = "abc123";
  process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETEXAMPLE";
  process.env.R2_BUCKET_NAME = "my-bucket";

  const url = mediaStorage.createPresignedGetUrl(
    "meta-outbound/123/photo a.jpg",
    {
      expiresSeconds: 900,
      now: new Date("2026-09-02T07:30:00.000Z"),
    }
  );

  assert.equal(
    url,
    "https://abc123.r2.cloudflarestorage.com/my-bucket/meta-outbound/123/photo%20a.jpg" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIDEXAMPLE%2F20260902%2Fauto%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20260902T073000Z" +
      "&X-Amz-Expires=900" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=e1b1d9db37df83e46bbd0d6137100b794b46f53c55bed5cc3cb6f51240d2faea"
  );
});

test("R2 presigned GET URL clamps expiry to S3 maximum", (t) => {
  const original = {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET_NAME,
  };
  t.after(() => {
    if (original.accountId === undefined) delete process.env.R2_ACCOUNT_ID;
    else process.env.R2_ACCOUNT_ID = original.accountId;
    if (original.accessKeyId === undefined) delete process.env.R2_ACCESS_KEY_ID;
    else process.env.R2_ACCESS_KEY_ID = original.accessKeyId;
    if (original.secretAccessKey === undefined) delete process.env.R2_SECRET_ACCESS_KEY;
    else process.env.R2_SECRET_ACCESS_KEY = original.secretAccessKey;
    if (original.bucket === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = original.bucket;
  });

  process.env.R2_ACCOUNT_ID = "abc123";
  process.env.R2_ACCESS_KEY_ID = "AKIDEXAMPLE";
  process.env.R2_SECRET_ACCESS_KEY = "SECRETEXAMPLE";
  process.env.R2_BUCKET_NAME = "my-bucket";

  const url = new URL(
    mediaStorage.createPresignedGetUrl("file.jpg", {
      expiresSeconds: 9999999,
      now: new Date("2026-09-02T07:30:00.000Z"),
    })
  );
  assert.equal(url.searchParams.get("X-Amz-Expires"), "604800");
});
